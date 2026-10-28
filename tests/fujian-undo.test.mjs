import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';

test('undo only reverses the local edit and preserves unrelated remote changes',()=>{
 const html=readFileSync(new URL('../fujian/index.html',import.meta.url),'utf8');
 const script=html.match(/<script>\n([\s\S]*?)<\/script>/)[1];
 const remember=script.slice(script.indexOf('function remember('),script.indexOf('function notifyChange('));
 const undo=script.slice(script.indexOf("$('undoBtn').onclick="),script.indexOf('\nfunction ask('));
 const button={},context={COUNTIES:[{id:'350102'},{id:'350527'}],Set,$:()=>button,save:()=>true,render(){},message(){},notifyChange(){}};
 vm.createContext(context);
 vm.runInContext('let visited=new Set(),history=[];'+remember,context);
 vm.runInContext("remember(['350102']);visited=new Set(['350102','350527']);",context);
 vm.runInContext(undo,context);button.onclick();
 assert.deepEqual([...vm.runInContext('[...visited]',context)],['350527']);
});
