import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { runInNewContext } from 'node:vm';
import { compile } from '@vue/compiler-dom';
import * as Vue from 'vue';
import { normalizePlayingStyle, normalizePlayingBackground, resolvePlayingBackground, playingLyricNeighbours, playingWordPulse } from '../uni_modules/qt-ui/composables/playing-style.ts';
const read = path => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
const source = read('uni_modules/qt-ui/stores/playing-style.ts');
const runnable = stripTypeScriptTypes(source.replace(/^import .*;$/gm, '').replace(/^export /gm, ''), { mode: 'strip' });
const disk = new Map();
let failRead = false, failSave = false;
function boot() {
  return runInNewContext(runnable + '\n({usePlayingStyle,selectPlayingStyle,selectPlayingBackground,savePlayingStyle});', {
    reactive: v => v, normalizePlayingStyle, normalizePlayingBackground,
    uni: { getStorageSync: key => { if(failRead) throw Error('unavailable'); return disk.get(key); },
      setStorageSync: (key,value) => { if(failSave) throw Error('full'); disk.set(key,value); } },
  });
}
let app = boot();
assert.equal(app.usePlayingStyle().style, 'classic');
app.selectPlayingStyle('gallery');
app.selectPlayingBackground('image', '/saved/cover.jpg');
app = boot();
assert.deepEqual(JSON.parse(JSON.stringify(app.usePlayingStyle())), {style:'gallery', background:'image', image:'/saved/cover.jpg', saveError:false});
app.selectPlayingStyle('focus');
assert.equal(app.usePlayingStyle().background, 'image', 'style changes preserve explicit background');
failSave = true;
app.selectPlayingBackground('midnight');
assert.equal(app.usePlayingStyle().saveError, true);
assert.equal(boot().usePlayingStyle().background, 'image', 'failed write must not pretend persisted');
failSave = false;
app.savePlayingStyle();
assert.equal(app.usePlayingStyle().saveError, false);
assert.equal(boot().usePlayingStyle().background, 'midnight');
for (const value of [null, 'bad', 1, {}, undefined]) {
  assert.equal(normalizePlayingStyle(value), 'classic');
  assert.equal(normalizePlayingBackground(value), 'auto');
}
const key = [...disk.keys()][0];
disk.set(key, JSON.stringify({style:'bad',background:'image'}));
assert.equal(boot().usePlayingStyle().background, 'auto');
disk.set(key, '{bad json');
app = boot();
assert.equal(app.usePlayingStyle().style, 'classic');
app.selectPlayingStyle('rhythm');
assert.equal(boot().usePlayingStyle().style, 'rhythm');
failRead = true;
app = boot();
assert.equal(app.usePlayingStyle().style, 'classic');
failRead = false;
assert.equal(app.usePlayingStyle().style, 'rhythm', 'transient read failure can recover');
for (const [s,b] of [['classic','theme'],['gallery','cover'],['rhythm','burgundy'],['focus','midnight']]) assert.equal(resolvePlayingBackground(s,'auto'),b);
assert.equal(resolvePlayingBackground('focus','forest'), 'forest');
const lines = [{text:'a'}, {text:' '}, {text:'b'}, {text:''}, {text:'c'}];
assert.deepEqual(playingLyricNeighbours([],0), []);
assert.deepEqual(playingLyricNeighbours(lines,0), [0,2]);
assert.deepEqual(playingLyricNeighbours(lines,1), [0,1,2]);
assert.deepEqual(playingLyricNeighbours(lines,2), [0,2,4]);
assert.deepEqual(playingLyricNeighbours(lines,10), [2,4]);
assert.equal(playingWordPulse(99,100,200),0);
assert.equal(playingWordPulse(200,100,200),1);
assert.ok(playingWordPulse(400,100,200)<0.00001);
assert.equal(playingWordPulse(200,100,200),playingWordPulse(200,100,200), 'paused playback has no moving clock');
assert.equal(playingWordPulse(0,100,200),0, 'seeking backward clears pulse');
const focusSource = read('uni_modules/qt-ui/components/qt-focus-lyrics/qt-focus-lyrics.uvue');
const focusScript = stripTypeScriptTypes(focusSource.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1].replace(/^import .*;$/gm,''), {mode:'strip'});
const props = {lines:[{time:10,text:'AB'},{time:12,text:'CD'}],activeIndex:0,position:10.5,rhythm:true,ink:'#fff',muted:'#aaa'};
const events = [];
const layout = {isWide:true};
const focus = runInNewContext(focusScript+'\n({currentWords,wordStyle,rows,currentIndex,lineStyle,subStyle,emit});', {defineProps:()=>props,defineEmits:()=>(...args)=>events.push(args),computed:get=>({get value(){return get();}}),useQtLayout:()=>layout,useFontScaleStore:()=>({scale:1}),qtFontDual:()=>'',playingLyricNeighbours,playingWordPulse});
assert.equal(focus.currentWords.value[1].startMs,1000);
assert.match(focus.wordStyle(0,1000),/translateY\(-5.00px\)/);
props.position=9;
assert.match(focus.wordStyle(0,1000),/color:#aaa;transform:translateY\(0.00px\)/);
props.lines[0].words=[{text:'exact',startMs:150,durationMs:300}];
assert.equal(focus.currentWords.value[0].startMs,150, 'native karaoke timing preserved');
props.lines=[];
assert.equal(focus.rows.value.length,0);
// Render the real fixed-verse template: tapping any verse/word must not seek;
// long-press still exposes copy, for both orientations and both verse renderers.
const template = focusSource.match(/<template>([\s\S]*?)<\/template>/)[1];
const render = new Function('Vue', compile(template, {mode:'function', prefixIdentifiers:true, isCustomElement:()=>true}).code)(Vue);
function descendants(node) {
  if (node == null || typeof node !== 'object') return [];
  return [node, ...(Array.isArray(node.children) ? node.children.flatMap(descendants) : [])];
}
props.lines = [{time:10,text:'前一句'},{time:20,text:'当前歌词',translation:'translation'},{time:30,text:'下一句'}];
props.activeIndex=1;
props.position=25;
props.heightPx=320;
for (const wide of [false,true]) {
  layout.isWide=wide;
  for (const rhythm of [false,true]) {
    props.rhythm=rhythm;
    const ctx = new Proxy({...props,...focus,layout}, {get(target,key) {
      const value=target[key];
      return value != null && typeof value === 'object' && 'value' in value ? value.value : value;
    }});
    const nodes=descendants(render(ctx,[]));
    assert.ok(nodes.every(node => node.props?.onClick == null), 'fixed verses must not bind tap seeking, including individual words');
    const rows=nodes.filter(node => (node.props?.class || '').split(' ').includes('fl-row'));
    assert.equal(rows.length,rhythm ? 2 : 3);
    const firstIndex=rhythm ? 1 : 0;
    rows[0].props.onLongpress({stopPropagation(){}});
    assert.deepEqual(events.at(-1), ['copy',props.lines[firstIndex],firstIndex]);
  }
}
assert.ok(events.every(event => event[0] === 'copy'));
const page=read('pages/player/index.uvue');
const consumers=page.match(/<QtFocusLyrics\b[^>]*>/g);
assert.equal(consumers.length,2);
assert.ok(consumers.every(tag => !tag.includes('@seek') && tag.includes('@copy="copyLyric"')));
// Exercise the actual page interaction boundary, including a queued old-style tap.
const seekCode=['seekToLine','onLyricLineTap'].map(name => page.match(new RegExp('function '+name+'\\([^]*?\\n\\}'))[0]).join('\n');
const seeks=[];
let toggles=0, followups=0;
const visible={value:true}, times={value:false}, target={value:1};
const actions=runInNewContext(stripTypeScriptTypes(seekCode)+'\n({seekToLine,onLyricLineTap});', {
  lyricVisible:visible, lyricTimesVisible:times, lyricTargetIndex:target, layout,
  player:{seek:time=>seeks.push(time)}, lyricOffsetSec:()=>1.25, lyricUserScrollAt:100,
  hideLyricTimes:()=>{times.value=false;}, updateLyricScroll:()=>followups++, toggleLyric:()=>toggles++,
});
for (const wide of [false,true]) {
  layout.isWide=wide;
  visible.value=true;
  times.value=false;
  actions.onLyricLineTap(props.lines[1],1);
  assert.equal(seeks.length,wide ? 1 : 0, 'ordinary taps on classic lyrics must not seek');
  times.value=true;
  actions.onLyricLineTap(props.lines[1],1);
  assert.equal(seeks.at(-1),21.25,'the manually scrolled target retains offset-aware seeking');
  visible.value=false;
  times.value=true;
  const count=seeks.length;
  actions.onLyricLineTap(props.lines[1],1);
  actions.seekToLine(props.lines[0]);
  assert.equal(seeks.length,count,'non-scrollable styles and hidden classic timeline ignore stale seek events');
}
assert.equal(toggles,1);
assert.equal(followups,2);
console.log('Playing style: preference restore/retry, background independence, lyric timing, fixed-verse tap/copy and classic scroll-target seeking passed');
