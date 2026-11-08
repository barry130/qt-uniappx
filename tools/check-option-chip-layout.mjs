import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { runInNewContext } from 'node:vm';
// Lead-confirmed UI seams under autonomous testing authorization:
// QtOption props -> rendered native styles; playlist page mount -> actual category option bindings.
// Tests inspect rendered bindings, never call textWidthPx or another private production helper.
// Native/Vue lifecycle, viewport, persisted settings and page-external network/source inputs are adapters.
const read = path => readFileSync(new URL('../' + path, import.meta.url), 'utf8').replaceAll('\r\n', '\n');
const strip = text => stripTypeScriptTypes(text.replace(/^import[\s\S]*?from\s+["'][^"']+["'];?\s*/gm, '').replace(/\bexport /g, ''), {mode:'strip'});
const setup = source => source.match(/<script setup[^>]*>([\s\S]*?)<\/script>/)[1];
const computed = getter => ({get value(){return getter();}});
const ref = value => ({value});
const layout={isWide:true,windowWidth:1098,windowHeight:686,sizeEpoch:0};
const mounts=[],unmounts=[],watches=[]; const timers=new Map(); let timerId=0;
const native={
  console, Map, Set, Promise, Math, Date, String, Number, ref, computed, reactive:value=>value,
  useQtLayout:()=>layout,qtIsWide:()=>layout.isWide,
  onMounted:cb=>mounts.push(cb),onUnmounted:cb=>unmounts.push(cb),onShow:()=>{},
  nextTick:cb=>cb(),setTimeout:cb=>{const id=++timerId;timers.set(id,cb);return id;},clearTimeout:id=>timers.delete(id),
  watch:(from,cb,opts)=>{watches.push({from,cb});if(opts?.immediate)cb(typeof from==='function'?from():from.value);},
  logWarn:()=>{},
  uni:{getStorageSync:()=>null,setStorageSync:()=>{},$on:()=>{},$off:()=>{},navigateTo:()=>{}},
};
const fonts=runInNewContext(strip(read('uni_modules/qt-ui/stores/font-scale.ts'))+'\n({fontScale,qtFontDual,useFontScaleStore});',native);
const selection=runInNewContext(strip(read('uni_modules/qt-ui/composables/selection.ts'))+'\n({qtSelectionColor});',native);
// Load the complete canonical layout module; only getWindowInfo is a native viewport adapter.
const canonicalLayout=runInNewContext(strip(read('uni_modules/qt-ui/composables/use-qt-layout.ts'))+'\n({qtRpx});',{
  ...native,uni:{...native.uni,getWindowInfo:()=>layout},
});
const base={...native,...fonts,...selection,...canonicalLayout};
// Use the real content-width contract: compact grid content deducts gutters even though its frame fills the window.
const widths=runInNewContext(strip(read('uni_modules/qt-ui/composables/use-qt-widths.ts'))+'\n({qtContentWidth});',{
  ...native,qtLayout:()=>layout,qtRailWidth:()=>layout.isWide?(layout.windowWidth>=900?96:64):0,
});
const reveal=runInNewContext(strip(read('uni_modules/qt-ui/composables/use-qt-selection-reveal.ts'))+'\n({useQtSelectionReveal});',base);
Object.assign(base,reveal);
const metricPath='uni_modules/qt-ui/composables/qt-option-metrics.ts';
if(existsSync(new URL('../'+metricPath,import.meta.url))) {
  const metricSource=read(metricPath);
  const names=[...metricSource.matchAll(/export function (\w+)/g)].map(match=>match[1]);
  Object.assign(base,runInNewContext(strip(metricSource)+'\n({'+names.join(',')+'});',base));
}
const source=read('pages/playlists/index.uvue');
const rowBinding=source.match(/v-for="\(row, rowIndex\) in ([^"]+)"[^>]*class="cat-row/)[1];
const categoryNode=source.match(/<QtOption v-for="cell in row"[^>]+\/>/)[0];
const widthBinding=categoryNode.match(/:style="([^"]+)"/)[1];
const labelBinding=categoryNode.match(/:label="([^"]+)"/)[1];
class Json {constructor(data){Object.assign(this,data);}get(k){return this[k]??null;}}
const categoryFixture = [new Json({id:'flow',name:'流行'}),new Json({id:'acg',name:'ACG'}),new Json({id:'movie',name:'影视原声'}),
  ...Array.from({length:67},(_,i)=>new Json({id:'cat-'+i,name:i===66?'最后分类':'分类'+i}))];
const requests=[];
const pageContext={...base,
  musicApi:{playlistCategories:async()=>categoryFixture,recommendations:async(...args)=>{requests.push(args);return []; }},
  useSourceStore:()=>({current:'wyy',restore:()=>{}}),
  useSourceRegistryStore:()=>({playlistSorts:()=>[],ensure:async()=>{}}),
  useThemeStore:()=>({dark:false,skin:{text:'#222222',textMuted:'#777777',surface:'#ffffff',divider:'#eeeeee'}}),
  packsFingerprint:()=>'meta-fixture@1',SOURCE_PACKS_CHANGED_EVENT:'test-packs',
  ...widths,qtColumnCount:()=>5,QT_MIN_COLUMN_WIDTH:{card:140},
  qtTrackError:()=>{},formatBigCount:String,qtShowToast:()=>{},logMsgErr:()=>{},
};
const panelNode=source.match(/<QtOption class="cat-grid-option"[^>]+\/>/)[0];
const panelLabel=panelNode.match(/:label="([^"]+)"/)[1];
const panelCell=source.match(/<view v-for="\(cat, columnIndex\) in row"[^>]+>/)[0];
const panelStyle=panelCell.match(/:style="([^"]+)"/)[1];
const widePanelNode=source.match(/<QtOption v-for="cell in row"[^>]*class="cat-panel-chip-wide"[^>]+\/>/)[0];
const widePanelStyle=widePanelNode.match(/:style="([^"]+)"/)[1];
const page=runInNewContext(strip(setup(source))+`\n({ onHeaderAction, closeCatPanel, onCatCellTap,
  setFrame(height, toolbar){pageElement.value={getBoundingClientRect:()=>({top:0,height}),querySelector:()=>({getBoundingClientRect:()=>({bottom:toolbar})})};},
  geometry(){return {height:catPanelHeight.value,top:panelTop.value,width:panelWidth.value,rows:panelCategoryRows.value.length,preview:visibleCategoryRows.value.length,previewWidth:previewWidth.value,rowStyle:categoryRowStyle.value};},
  renderCategories(){return ${rowBinding}.value.flatMap((row,rowIndex)=>row.map(cell=>({label:${labelBinding},style:${widthBinding}})));},
  renderWidePanel(){return catPanelVisible.value?panelCategoryRows.value.map(row=>row.map(cell=>({id:cell.id,label:cell.name,style:${widePanelStyle}}))):[];},
  renderCompactRows(){return catPanelVisible.value?compactCategoryRows.value.map(row=>row.map((cat,columnIndex)=>({id:cat.id,label:${panelLabel},style:${panelStyle}}))):[];},
  renderPanel(){return this.renderCompactRows().flat();}});`,pageContext);
for(const mount of [...mounts]) mount();
for(let i=0;i<24;i++) await Promise.resolve();
const optionSource=read('uni_modules/qt-ui/components/qt-option/qt-option.uvue');
const rootStyleExpr=optionSource.match(/<view class="qo"[^>]*:style="([^"]+)"/)[1];
const labelStyleExpr=optionSource.match(/<text[^>]*class="qo-label"[^>]*:style="([^"]+)"/)[1];
function renderOption(label){
  return runInNewContext(strip(setup(optionSource))+`\n({style:${rootStyleExpr}.value,labelStyle:${labelStyleExpr}.value});`,{
    ...base,defineProps:()=>({label,kind:'chip',selected:false}),withDefaults:(props,defaults)=>({...defaults,...props}),defineEmits:()=>()=>{},useThemeStore:pageContext.useThemeStore,
  });
}
const all=page.renderCategories().find(cell=>cell.label==='全部');
assert.ok(all,'mount must render the default all category from the actual page');
const width=Number(all.style.match(/width:([\d.]+)px/)[1]);
const option=renderOption(all.label);
assert.equal(Number(option.labelStyle.match(/font-size:([\d.]+)px/)[1]),17.25);
// Worked native geometry: two 17.25px CJK glyphs + 2*14px padding + 2*1px border = 64.5px.
assert.ok(width>=65,`normal wide 全部 must fit QtOption text/padding/border; rendered width ${width}px < 65px`);
console.log('option chip width: mounted category fits actual normal QtOption rendered typography');
const chipRule=optionSource.match(/\.qo-chip-wide\s*\{([^}]+)\}/)[1];
const minHeight=Number(option.style.match(/min-height:([\d.]+)px/)?.[1]??chipRule.match(/min-height:\s*([\d.]+)px/)[1]);
// 17.25px * 1.35 line-height + 2*6px vertical padding + 2*1px border rounds up to 38px.
assert.ok(minHeight>=38,`normal wide chip must protect its single-line glyph height even in a fixed-height parent; ${minHeight}px < 38px`);
console.log('option chip height: actual normal option protects the font-scaled line box');
for(const [tier,minWidth,minHeight] of [['tiny',56,36],['small',60,36],['normal',65,38],['large',69,41],['huge',75,45]]) {
  fonts.fontScale.setTier(tier);
  const cell=page.renderCategories().find(item=>item.label==='全部');
  const rendered=renderOption(cell.label);
  const w=Number(cell.style.match(/width:([\d.]+)px/)[1]);
  const h=Number(rendered.style.match(/min-height:([\d.]+)px/)[1]);
  assert.ok(w>=minWidth,`${tier} category border box must fit its visible complete label`);
  assert.ok(h>=minHeight,`${tier} chip must not clip its font-scaled line`);
  assert.equal(Number(page.geometry().rowStyle.match(/height:([\d.]+)px/)[1]),h+8,
    'native category row is exactly the current chip line box plus one 8px gap');
}
fonts.fontScale.setTier('normal');
console.log('option chip layout: five real font tiers keep mounted page labels and component line boxes legible');
const rowRule=source.match(/\.cat-row-wide\s*\{([^}]+)\}/)[1];
const tagRule=source.match(/\.cat-tag-wide\s*\{([^}]+)\}/)[1];
const fixedRowHeight=rowRule.match(/(?:^|;)\s*height:\s*([\d.]+)px/);
const bottomMargin=Number(tagRule.match(/margin-bottom:\s*([\d.]+)px/)[1]);
assert.ok(fixedRowHeight==null||Number(fixedRowHeight[1])>=minHeight+bottomMargin,
  `playlist category parent must not clip its protected chip plus row gap: ${fixedRowHeight?.[1]}px < ${minHeight+bottomMargin}px`);
console.log('option chip parent: category row allows actual option height plus breathing room');
// The old test only checked -wide; the inherited .cat-row 72rpx height caused
// the 100+ logical px row gaps on the device. Inspect all classes on the row.
const previewClasses=source.match(/v-for="\(row, rowIndex\) in [^"]+"[^>]*class="([^"]+)"/)[1].split(/\s+/);
for(const cls of previewClasses) {
  const rule=source.match(new RegExp('\\.'+cls+'\\s*\\{([^}]+)\\}'))?.[1]??'';
  assert.ok(!/(?:^|;)\s*height:\s*[\d.]+(?:rpx|px)/.test(rule),'preview must grow from chip height, without inherited phone row height');
}
const beforePreview=page.renderCategories().map(cell=>cell.label);
page.setFrame(510,144);
page.onHeaderAction('grid');
const widePanel=page.renderWidePanel();
assert.equal(widePanel.flat().length,71,'all categories are available inside the floating panel');
assert.equal(page.geometry().preview,1,'the page keeps only one preview row');
assert.deepEqual(page.renderCategories().map(cell=>cell.label),beforePreview,'opening the panel does not expand the page header');
assert.equal(page.geometry().top,148,'panel anchors just below the measured toolbar');
assert.ok(page.geometry().height+page.geometry().top<510,'scroll viewport fits above the page/player boundary');
assert.ok(page.geometry().height<widePanel.length*(minHeight+8)+24,'long categories overflow the bounded scroll viewport');
for(const row of widePanel) {
  const sum=row.reduce((n,cell)=>n+Number(cell.style.match(/width:([\d.]+)px/)[1]),0)+8*(row.length-1);
  assert.ok(sum<=page.geometry().width-34,'content-sized chips fit the floating panel interior');
}
const beforePick=requests.length;
page.onCatCellTap('cat-66');
assert.equal(page.renderWidePanel().length,0,'picking the last category closes the floating panel');
assert.equal(requests.length,beforePick+1);
assert.equal(requests.at(-1)[1],'cat-66','the actual category id reaches recommendations');
page.onHeaderAction('grid');page.closeCatPanel();
assert.equal(page.renderWidePanel().length,0,'outside dismissal closes without selecting');
assert.equal(requests.length,beforePick+1);
console.log('playlist floating categories: 71 options, one stable preview row, measured bounds, selection and dismissal');
layout.isWide=false;layout.windowWidth=320;layout.windowHeight=640;
fonts.fontScale.setTier('huge');
page.onHeaderAction('grid');
const compactCell=page.renderPanel().find(cell=>cell.label==='影视原声');
assert.ok(compactCell,'the real header action must render the all-category panel');
const compactText=renderOption(compactCell.label).labelStyle.match(/font-size:([\d.]+)(rpx|px)/);
const compactFont=Number(compactText[1])*(compactText[2]==='rpx'?320/750:1);
const compactRequired=Math.ceil(4*compactFont+2*24*(320/750)+2*(320/750));
const compactWidth=Number(compactCell.style.match(/width:([\d.]+)px/)[1]);
assert.ok(compactWidth>=compactRequired,`320px huge-font category panel must fit its four visible glyphs: ${compactWidth}px < ${compactRequired}px`);
console.log('option chip compact panel: header interaction preserves complete category labels at 320px huge font');
for(const windowWidth of [320,375,414,686]) {
  layout.windowWidth=windowWidth;layout.windowHeight=windowWidth*2;layout.sizeEpoch++;
  for(const tier of ['tiny','small','normal','large','huge']) {
    fonts.fontScale.setTier(tier);
    const cell=page.renderPanel().find(item=>item.label==='影视原声');
    const labelFont=renderOption(cell.label).labelStyle.match(/font-size:([\d.]+)(rpx|px)/);
    const unit=windowWidth/750;
    const f=Number(labelFont[1])*(labelFont[2]==='rpx'?unit:1);
    const required=Math.ceil(4*f+2*24*unit+2*unit);
    const width=Number(cell.style.match(/width:([\d.]+)px/)[1]);
    assert.ok(width>=required,`${windowWidth}px ${tier} mounted panel must react to live font/window changes`);
    assert.equal(page.geometry().width,windowWidth,'portrait popup fills its page instead of deducting wide gutters');
    const rows=page.renderCompactRows();
    assert.equal(rows.flat().length,71,'portrait rows retain every category including the final partial row');
    const inner=windowWidth-30;
    for(const row of rows) {
      const occupied=row.reduce((n,cell,i)=>n+Number(cell.style.match(/width:([\d.]+)px/)[1])+(i<row.length-1?10:0),0);
      assert.ok(occupied<=inner,'native cells and gaps fit within the bordered panel');
      if(row.length===rows[0].length) assert.ok(inner-occupied<row.length,'full rows fill the available width without an empty right column');
    }
  }
}
layout.windowWidth=375;fonts.fontScale.setTier('normal');
const normalPanel=page.renderPanel();
assert.match(normalPanel[2].style,/margin-right:0px;/,'ordinary compact typography keeps the existing three-column density');
console.log('option chip live panel: four compact widths × five real font tiers react without remount, ordinary density retained');
const compactRowRule=source.match(/\.cat-grid-row\s*\{([^}]+)\}/)[1];
assert.match(compactRowRule,/flex-wrap:\s*nowrap/,'explicit native rows cannot rewrap QtOption component hosts');
assert.match(source.match(/\.cat-sort-slot\s*\{([^}]+)\}/)[1],/margin-right:\s*10px/,'sort option spacing belongs to a native wrapper');
for(const [windowWidth,windowHeight] of [[686,390],[1098,618],[1440,900]]) {
  layout.isWide=true;layout.windowWidth=windowWidth;layout.windowHeight=windowHeight;
  for(const tier of ['tiny','small','normal','large','huge']) {
    fonts.fontScale.setTier(tier);
    page.closeCatPanel();page.setFrame(windowHeight-110,130);page.onHeaderAction('grid');
    assert.equal(page.renderWidePanel().flat().length,71);
    assert.equal(page.geometry().preview,1);
    const preview=page.renderCategories();
    const occupied=preview.reduce((n,cell)=>n+Number(cell.style.match(/width:([\d.]+)px/)[1])+8,0);
    assert.ok(occupied<=page.geometry().previewWidth,'preview chips leave room for the same-line all-categories action');
    assert.ok(page.geometry().height>0 && page.geometry().top+page.geometry().height<=windowHeight-124,
      'wide/short/font changes keep a positive scroll viewport above the footer');
  }
}
console.log('playlist floating categories: three wide/short windows × five font tiers preserve every category and bounded scrolling');
layout.isWide=true;layout.windowWidth=1098;layout.windowHeight=686;fonts.fontScale.setTier('normal');
for(const unmount of unmounts) unmount();
