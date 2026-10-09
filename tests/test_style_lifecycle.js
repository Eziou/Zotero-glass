const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const source = fs.readFileSync(
  path.join(root, "zotero-glass-plugin/chrome/content/zoteroGlass.js"),
  "utf8"
);

function createFixture(modern = false) {
  const context = vm.createContext({});
  vm.runInContext(source, context, { filename: "zoteroGlass.js" });
  const glass = context.ZoteroGlass;
  const logs = [];
  const decorations = [];
  let pluginObserver = null;

  const itemTreePrototype = {
    _renderCell(index, data, column, isFirstColumn) {
      if (modern) {
        return this.getRow(index).renderCell(index, data, column, isFirstColumn, this._renderCtx);
      }
      return { dataKey: column.dataKey };
    },
  };
  const itemTreeModule = { prototype: itemTreePrototype };
  const renderCalls = [];
  // In Zotero 10, the collection view inherits _renderCell from ItemTree,
  // and the base method delegates ordinary cells to the row subclass.
  const collectionViewPrototype = Object.create(itemTreePrototype);
  const view = Object.create(collectionViewPrototype);
  view._renderCtx = { id: "row-render-context" };
  view.getRow = index => ({
    renderCell(...args) {
      renderCalls.push(args);
      return { dataKey: args[2].dataKey, rowIndex: index };
    },
  });
  let invalidations = 0;
  const visibleCells = {
    "#zotero-items-tree .cell.zoterostyle-status": [{ id: "visible-status" }],
    "#zotero-items-tree .cell.zoterostyle-textTags": [{ id: "visible-text" }],
    "#zotero-items-tree .cell.zoterostyle-publicationTags": [{ id: "visible-publication" }],
  };
  const doc = {
    getElementById(id) {
      return id === "zotero-pane" || id === "zotero-items-tree" ? {} : null;
    },
    querySelectorAll(selector) {
      return visibleCells[selector] || [];
    },
  };
  const win = {
    document: doc,
    require(moduleID) {
      assert.equal(moduleID, "zotero/itemTree");
      return itemTreeModule;
    },
    ZoteroPane: {
      itemsView: Object.assign(view, {
        tree: {
          invalidate() {
            invalidations += 1;
          },
        },
      }),
    },
  };

  context.Services = {
    wm: {
      getEnumerator() {
        let consumed = false;
        return {
          hasMoreElements() {
            return !consumed;
          },
          getNext() {
            consumed = true;
            return win;
          },
        };
      },
    },
  };
  context.Zotero = {
    Plugins: {
      addObserver(observer) {
        pluginObserver = observer;
      },
      removeObserver(observer) {
        assert.equal(observer, pluginObserver);
        pluginObserver = null;
      },
    },
  };

  glass.log = message => logs.push(message);
  glass.decorateStyleTagCell = (kind, cell) => {
    decorations.push([kind, cell]);
    cell.decoratedByGlass = kind;
    return 1;
  };

  return {
    glass,
    logs,
    decorations,
    invalidations: () => invalidations,
    itemTreePrototype,
    collectionViewPrototype,
    view,
    win,
    renderCalls,
    pluginObserver: () => pluginObserver,
  };
}

{
  const fixture = createFixture();
  const originalRenderer = fixture.itemTreePrototype._renderCell;
  fixture.glass.startStyleTagIntegration();
  assert.notEqual(fixture.itemTreePrototype._renderCell, originalRenderer);
  assert.equal(fixture.invalidations(), 1);
  assert.match(fixture.logs.at(-1), /hooks=1 cells=3/);

  for (const [dataKey, kind] of [
    ["zoterostyle-status", "status"],
    ["zoterostyle-textTags", "textTags"],
    ["zoterostyle-publicationTags", "publicationTags"],
  ]) {
    const cell = fixture.itemTreePrototype._renderCell(0, "", { dataKey });
    assert.equal(cell.decoratedByGlass, kind);
  }
  const plain = fixture.itemTreePrototype._renderCell(0, "", { dataKey: "title" });
  assert.equal(plain.decoratedByGlass, undefined);

  const styleWrapper = function (...args) {
    return originalRenderer.apply(this, args);
  };
  fixture.itemTreePrototype._renderCell = styleWrapper;
  fixture.pluginObserver().startup({ id: "zoterostyle@polygon.org" });
  assert.notEqual(fixture.itemTreePrototype._renderCell, styleWrapper);

  const beforeStop = fixture.decorations.length;
  fixture.glass.stopStyleTagIntegration();
  assert.equal(fixture.itemTreePrototype._renderCell, styleWrapper);
  assert.equal(fixture.pluginObserver(), null);
  fixture.itemTreePrototype._renderCell(0, "", { dataKey: "zoterostyle-status" });
  assert.equal(fixture.decorations.length, beforeStop);
}

{
  const fixture = createFixture(true);
  const originalRenderer = fixture.itemTreePrototype._renderCell;
  fixture.glass.startStyleTagIntegration();
  const column = { dataKey: "zoterostyle-status", custom: true };
  const data = 'unread\n{"tag":"/unread","color":"#6fafdb"}';
  const cell = fixture.view._renderCell(2, data, column, false);
  assert.equal(cell.decoratedByGlass, "status");
  assert.deepEqual(fixture.renderCalls[0], [2, data, column, false, fixture.view._renderCtx]);
  assert.equal(Object.hasOwn(fixture.collectionViewPrototype, "_renderCell"), false);
  // A column outside Style remains untouched. Non-item library header/spacer
  // rows are reconciled by DOM selectors without being read as Zotero items.
  const plain = fixture.view._renderCell(0, "Library", { dataKey: "title" }, true);
  assert.equal(plain.decoratedByGlass, undefined);
  fixture.view.getRow = () => { throw new Error("Must not inspect header/spacer rows"); };
  assert.equal(fixture.glass.refreshStyleTagIntegration("multi-selection").cells, 3);
  assert.equal(fixture.invalidations(), 1);
  assert.equal(fixture.glass.removeStyleTagRenderHook(fixture.win), true);
  assert.equal(fixture.view._renderCell, originalRenderer);
  assert.equal(fixture.glass.styleRenderHooks.size, 0);
  fixture.glass.stopStyleTagIntegration();
}

{
  const fixture = createFixture(true);
  fixture.glass.startStyleTagIntegration();
  const glassWrapper = fixture.itemTreePrototype._renderCell;
  const laterWrapper = function (...args) { return glassWrapper.apply(this, args); };
  fixture.itemTreePrototype._renderCell = laterWrapper;
  fixture.glass.stopStyleTagIntegration();
  assert.equal(fixture.itemTreePrototype._renderCell, laterWrapper);
  const cell = fixture.view._renderCell(1, "", { dataKey: "zoterostyle-status" }, false);
  assert.equal(cell.decoratedByGlass, undefined);
}

{
  const fixture = createFixture();
  fixture.glass.styleTagBackgroundOpacity = 0.85;
  assert.equal(
    fixture.glass.styleTagPalette("rgba(111, 175, 219, 0.13)").background,
    "rgba(111, 175, 219, 0.85)"
  );
  assert.equal(
    fixture.glass.styleTagPalette(
      "rgb(111 175 219 / var(--zotero-glass-style-tag-opacity, 0.85))"
    ).background,
    "rgba(111, 175, 219, 0.85)"
  );
  assert.equal(
    fixture.glass.styleTagPalette("rgba(111, 175, 219, 0)").background,
    "rgba(111, 175, 219, 0.85)"
  );
  assert.equal(
    fixture.glass.styleTagPalette("#6fafdb").background,
    "rgba(111, 175, 219, 0.85)"
  );
}

function fakeStyle(backgroundColor = "") {
  return {
    backgroundColor,
    background: backgroundColor,
    values: {},
    setProperty(name, value) {
      this.values[name] = value;
      if (name === "background-color") this.backgroundColor = value;
      if (name === "background") this.background = value;
    },
  };
}

{
  const fixture = createFixture();
  const label = { style: fakeStyle("rgba(20, 30, 40, 0.2)") };
  const dot = { style: fakeStyle("rgb(255, 255, 255)"), matches: () => true };
  const inner = { style: fakeStyle() };
  const chip = {
    style: fakeStyle(),
    parentElement: null,
    querySelectorAll(selector) {
      if (selector === "span") return [label];
      if (selector === ".circle > div") return [dot];
      return [];
    },
  };
  const cell = {
    firstElementChild: chip,
    querySelector(selector) {
      return selector === ".inner" ? inner : null;
    },
  };
  chip.parentElement = cell;
  inner.parentElement = chip;
  label.parentElement = inner;

  fixture.glass.styleTagBackgroundOpacity = 0.85;
  assert.equal(
    fixture.glass.solidifyStyleStatusCell(
      cell,
      'unread\n{"tag":"/unread","color":"#6fafdb"}'
    ),
    true
  );
  assert.equal(chip.style.backgroundColor, "rgba(111, 175, 219, 0.85)");
  assert.equal(chip.style.values["border-radius"], undefined);
  assert.equal(chip.style.values.border, undefined);
  assert.equal(label.style.backgroundColor, "rgba(20, 30, 40, 0.2)");
  assert.equal(dot.style.backgroundColor, "#FFFFFF");
}

{
  const fixture = createFixture();
  const chip = {
    textContent: "Q1",
    style: fakeStyle("rgba(255, 226, 221, 0)"),
  };
  const cell = {
    querySelectorAll(selector) {
      return selector === "span" ? [chip] : [];
    },
  };
  fixture.glass.styleTagBackgroundOpacity = 0.85;
  assert.equal(fixture.glass.solidifyStyleTextTagCell(cell), 1);
  assert.equal(chip.style.backgroundColor, "rgba(255, 226, 221, 0.85)");
  assert.equal(chip.style.values.color, undefined);
  assert.equal(chip.style.values.opacity, undefined);
  fixture.glass.styleTagBackgroundOpacity = 0.42;
  assert.equal(fixture.glass.solidifyStyleTextTagCell(cell), 1);
  assert.equal(chip.style.backgroundColor, "rgba(255, 226, 221, 0.42)");
}

{
  const fixture = createFixture();
  const chip = {
    textContent: "ghgjh",
    style: fakeStyle("rgba(142, 68, 173, 0.13)"),
  };
  const cell = {
    querySelectorAll(selector) {
      return selector === "span" ? [chip] : [];
    },
  };
  fixture.glass.styleTagBackgroundOpacity = 0.68;
  assert.equal(fixture.glass.solidifyStyleTextTagCell(cell, true), 1);
  assert.equal(chip.style.backgroundColor, "rgba(142, 68, 173, 0.68)");
  assert.equal(chip.style.values.color, "#FFFFFF");
  assert.equal(chip.style.values.opacity, "1");
}

console.log("Style tag render-hook lifecycle scenarios passed");
