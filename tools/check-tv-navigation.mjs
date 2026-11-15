import assert from 'node:assert/strict';
import { createQtTvNavigation } from '../uni_modules/qt-ui/composables/qt-tv-navigation.ts';
let cases=0;
function test(name,fn){fn();cases++;console.log('PASS '+name);}
const item=(id,left,top,width=120,height=64,extra={})=>({id,left,top,width,height,visible:true,enabled:true,input:false,longPress:false,...extra});
function setup(){let nodes=[],now=0,scroll=()=>false;const effects=[];const nav=createQtTvNavigation({collect:root=>nodes.filter(x=>root==null||x.root==null||x.root===root),highlight:id=>effects.push(['focus',id]),activate:(id,longPress)=>effects.push(['activate',id,longPress]),scroll:(id,key)=>{effects.push(['scroll',id,key]);return scroll(id,key);},back:()=>effects.push(['back']),now:()=>now});return {nav,effects,set:n=>nodes=n,advance:n=>now+=n,scroll:fn=>scroll=fn};}
test('directional-focus-keeps-row-instead-of-nearest-diagonal',()=>{const h=setup();h.set([item('start',0,0),item('row-next',180,0),item('near-diagonal',130,90)]);h.nav.setEnabled(true);h.nav.pushScope({root:null,active:()=>true,modal:false});h.nav.refresh();assert.equal(h.nav.focusedId(),'start');h.nav.dispatch({key:'right',repeat:0});assert.equal(h.nav.focusedId(),'row-next');h.nav.dispatch({key:'ok',repeat:0});assert.deepEqual(h.effects.at(-1),['activate','row-next',false]);});
test('scrollable-list-reveals-next-page-before-jumping-to-dock',()=>{const h=setup();h.set([item('last-visible',200,80,120,64,{scrollGroup:'songs'}),item('dock',200,210)]);h.scroll(()=>{h.set([item('next-visible',200,80,120,64,{scrollGroup:'songs'}),item('dock',200,210)]);return true;});h.nav.setEnabled(true);h.nav.pushScope({root:'page',active:()=>true,modal:false});h.nav.dispatch({key:'down',repeat:0});assert.equal(h.nav.focusedId(),'next-visible');assert.ok(h.effects.some(x=>x[0]==='scroll'&&x[1]==='last-visible'&&x[2]==='down'));h.scroll(()=>false);h.nav.dispatch({key:'down',repeat:0});assert.equal(h.nav.focusedId(),'dock','dock becomes reachable at the actual list boundary');});
test('business-focus-id-resolves-only-in-active-scope',()=>{const h=setup();h.set([item('tv:app:page:custom:first',0,0),item('tv:app:page:custom:queue-occurrence-2',180,0)]);h.nav.setEnabled(true);h.nav.pushScope({root:'page',active:()=>true,modal:false});assert.equal(h.nav.focus('queue-occurrence-2'),true,'public callers use stable business IDs without guessing page prefixes');assert.equal(h.nav.focusedId(),'tv:app:page:custom:queue-occurrence-2');assert.equal(h.nav.focus('hidden-page-row'),false);});
test('visible-null-root-modal-blocks-background-before-mount',()=>{const h=setup();h.set([item('background',0,0)]);h.nav.setEnabled(true);h.nav.pushScope({root:'page',active:()=>true,modal:false});let root=null;const modal=h.nav.pushScope({root:null,getRoot:()=>root,active:()=>true,modal:true});assert.equal(h.nav.focusedId(),'');assert.equal(h.nav.modalActive(),true);h.nav.dispatch({key:'ok',repeat:0});h.nav.dispatch({key:'back',repeat:0});assert.equal(h.effects.some(x=>x[0]==='back'||x[0]==='activate'),false);root='dialog';h.set([item('dialog-ok',0,0,120,64,{root:'dialog'})]);h.nav.refresh();assert.equal(h.nav.focusedId(),'dialog-ok');h.nav.removeScope(modal);});
test('highest-modal-rank-and-newest-peer-then-restore-owner',()=>{const h=setup();h.set([item('page-1',0,0,120,64,{root:'page'}),item('page-2',180,0,120,64,{root:'page'}),item('queue',0,0,120,64,{root:'queue'}),item('confirm',0,0,120,64,{root:'confirm'}),item('notice',0,0,120,64,{root:'notice'})]);h.nav.setEnabled(true);h.nav.pushScope({root:'page',active:()=>true,modal:false});h.nav.focus('page-2');const q=h.nav.pushScope({root:'queue',active:()=>true,modal:true,priority:1400});const c=h.nav.pushScope({root:'confirm',active:()=>true,modal:true,priority:3000,onBack:()=>h.nav.removeScope(c)});const n=h.nav.pushScope({root:'notice',active:()=>true,modal:true,priority:1700});assert.equal(h.nav.focusedId(),'confirm');h.nav.dispatch({key:'back',repeat:0});assert.equal(h.nav.focusedId(),'notice');const peer=h.nav.pushScope({root:'queue',active:()=>true,modal:true,priority:1700});assert.equal(h.nav.focusedId(),'queue','newest equal-rank modal wins');h.nav.removeScope(peer);assert.equal(h.nav.focusedId(),'notice');h.nav.removeScope(n);assert.equal(h.nav.focusedId(),'queue');h.nav.removeScope(q);assert.equal(h.nav.focusedId(),'page-2','closing overlays restores the previous page occurrence');});
test('reordered-and-recycled-rows-preserve-identity-then-nearest-position', () => {
  const h = setup(); h.set([item('first', 0, 0), item('selected', 0, 100), item('last', 0, 200)]);
  h.nav.setEnabled(true); h.nav.pushScope({ root:'page', active:() => true, modal:false });
  assert.equal(h.nav.focus('selected'), true);
  h.set([item('last', 0, 0), item('first', 0, 100), item('selected', 0, 200)]); h.nav.refresh();
  assert.equal(h.nav.focusedId(), 'selected', 'reordering follows business identity instead of old index');
  h.nav.dispatch({ key:'ok', repeat:0 }); assert.deepEqual(h.effects.at(-1), ['activate', 'selected', false]);
  h.set([item('new-top', 0, 0), item('replacement', 0, 198), item('distant', 300, 200)]); h.nav.refresh();
  assert.equal(h.nav.focusedId(), 'replacement', 'removed rows fall back to nearby visible geometry');
});
test('inactive-and-disposed-scopes-never-receive-actions', () => {
  const h = setup(); let pageActive = true, overlayActive = true;
  h.set([item('page-item', 0, 0, 120, 64, { root:'page' }), item('modal-item', 0, 0, 120, 64, { root:'modal' })]);
  h.nav.setEnabled(true);
  const page = h.nav.pushScope({ root:'page', active:() => pageActive, modal:false });
  const modal = h.nav.pushScope({ root:'modal', active:() => overlayActive, modal:true });
  assert.equal(h.nav.focusedId(), 'modal-item');
  overlayActive = false; h.nav.dispatch({ key:'ok', repeat:0 });
  assert.deepEqual(h.effects.at(-1), ['activate', 'page-item', false]);
  pageActive = false; h.nav.refresh(); assert.equal(h.nav.focusedId(), '');
  assert.equal(h.nav.dispatch({ key:'back', repeat:0 }), false);
  h.nav.removeScope(modal); overlayActive = true; h.nav.refresh(); assert.equal(h.nav.modalActive(), false);
  pageActive = true; h.nav.refresh(); assert.equal(h.nav.focusedId(), 'page-item');
  h.nav.removeScope(page); assert.equal(h.nav.activeToken(), 0);
  assert.equal(h.nav.dispatch({ key:'ok', repeat:0 }), false);
});
test('invalid-candidates-and-ambiguous-business-ids-are-skipped', () => {
  const h = setup(); h.set([
    item('hidden', 0, 0, 120, 64, { visible:false }), item('disabled', 0, 0, 120, 64, { enabled:false }),
    item('zero', 0, 0, 0, 64), item('negative', 0, 0, 120, -1), item('nan', NaN, 0),
    item('infinite', 0, 0, Infinity), item('', 0, 0),
    item('tv:app:a:custom:duplicate', 0, 0), item('tv:app:b:custom:duplicate', 200, 0),
  ]);
  h.nav.setEnabled(true); h.nav.pushScope({ root:'page', active:() => true, modal:false });
  assert.equal(h.nav.focusedId(), 'tv:app:a:custom:duplicate');
  for (const id of ['hidden', 'disabled', 'zero', 'negative', 'nan', 'infinite', '', 'duplicate']) assert.equal(h.nav.focus(id), false, id);
  assert.equal(h.nav.focus('tv:app:b:custom:duplicate'), true, 'full native identity remains exact');
  h.nav.dispatch({ key:'right', repeat:0 }); assert.equal(h.nav.focusedId(), 'tv:app:b:custom:duplicate', 'edge never wraps');
});
test('action-repeats-are-swallowed-and-direction-repeat-is-throttled', () => {
  const h = setup(); h.set([item('a', 0, 0), item('b', 200, 0, 120, 64, { longPress:true }), item('c', 400, 0)]);
  h.nav.setEnabled(true); h.nav.pushScope({ root:'page', active:() => true, modal:false });
  h.nav.dispatch({ key:'right', repeat:0 }); assert.equal(h.nav.focusedId(), 'b');
  h.advance(84); h.nav.dispatch({ key:'right', repeat:1 }); assert.equal(h.nav.focusedId(), 'b');
  h.advance(1); h.nav.dispatch({ key:'right', repeat:2 }); assert.equal(h.nav.focusedId(), 'c');
  h.nav.focus('b'); h.effects.length = 0;
  for (const key of ['ok', 'menu', 'back']) h.nav.dispatch({ key, repeat:1 });
  assert.deepEqual(h.effects, []);
  h.nav.dispatch({ key:'menu', repeat:0 }); assert.deepEqual(h.effects.at(-1), ['activate', 'b', true]);
  h.nav.focus('a'); h.effects.length = 0; h.nav.dispatch({ key:'menu', repeat:0 }); assert.deepEqual(h.effects, []);
  assert.equal(h.nav.dispatch({ key:'volume-up', repeat:0 }), false);
  h.nav.setEnabled(false); assert.equal(h.nav.focusedId(), '');
  assert.equal(h.nav.dispatch({ key:'ok', repeat:0 }), false);
});
test('same-scroll-group-moves-without-scrolling-and-exhausted-edge-stays', () => {
  const h = setup(); h.set([item('one', 0, 0, 120, 64, { scrollGroup:'list' }), item('two', 0, 100, 120, 64, { scrollGroup:'list' })]);
  h.nav.setEnabled(true); h.nav.pushScope({ root:'page', active:() => true, modal:false });
  h.nav.dispatch({ key:'down', repeat:0 }); assert.equal(h.nav.focusedId(), 'two');
  assert.equal(h.effects.filter(e => e[0] === 'scroll').length, 0);
  h.nav.dispatch({ key:'down', repeat:0 }); assert.equal(h.nav.focusedId(), 'two');
  assert.equal(h.effects.filter(e => e[0] === 'scroll').length, 1);
});
console.log('TV navigation: '+cases+' cases');
