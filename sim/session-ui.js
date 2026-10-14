// Память управления хранится отдельно от физики. Файл вклеивается после
// controls/mobile; функции вызываются только у полностью запущенной сцены.
function sessionPanelIds() {
  return ['wind','winddir','hike','sailscale','gust','twist','draft','fetch','fetchover','cur',
    'shd0','shk','shg','chan','mainsheet','jibsheet','mainup','jibup','jibtwist','jibdraft',
    'genup','gensheet','genpressure','oldsail'].filter(k=>ui[k]);
}
function captureSessionUI() {
  return {schema:'sv20-input-state-v1',mode:MOBILE_UI?'game':'debug',
    panel:Object.fromEntries(sessionPanelIds().map(k=>[k,ui[k].type==='checkbox'?ui[k].checked:ui[k].value])),
    autopilot,apHeading,held:Object.fromEntries(['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','KeyW','KeyA','KeyS','KeyD','KeyR','KeyF'].map(k=>[k,!!keys[k]])),
    game:{sheet:{...gameSheet},at:{...gameSheetAt},tiller:gameTiller,crew:gameCrew}};
}
function prepareSessionUI(raw) {
  const v=structuredClone(raw),bad=()=>{throw new Error('Некорректное состояние управления снимка');};
  if(v?.schema!=='sv20-input-state-v1'||v.mode!==(MOBILE_UI?'game':'debug')||typeof v.autopilot!=='boolean'||!Number.isFinite(v.apHeading))bad();
  const ids=sessionPanelIds(),held=Object.keys(captureSessionUI().held);
  if(!v.panel||Object.keys(v.panel).length!==ids.length||!v.held||Object.keys(v.held).length!==held.length)bad();
  for(const k of ids) {
    const el=ui[k],x=v.panel[k];
    if(el.type==='checkbox'){if(typeof x!=='boolean')bad();}
    else {
      if(typeof x!=='string'||!Number.isFinite(Number(x)))bad();
      // value у range сериализуется браузером с иным числом разрядов, чем
      // min/max. Проверяем каноническое представление самим input, без нового
      // допуска физики и без изменения живого органа во время валидации.
      const probe=el.cloneNode(false);probe.value=x;
      if(probe.value!==x||(el.type!=='range'&&((el.min!==''&&Number(x)<Number(el.min))||(el.max!==''&&Number(x)>Number(el.max)))))bad();
    }
  }
  for(const k of held)if(typeof v.held[k]!=='boolean')bad();
  for(const key of ['sheet','at'])for(const k of ['main','jib'])if(!Number.isFinite(v.game?.[key]?.[k])||v.game[key][k]<0||v.game[key][k]>1)bad();
  for(const k of ['tiller','crew'])if(!Number.isFinite(v.game?.[k])||Math.abs(v.game[k])>1)bad();
  if(v.panel.oldsail||v.panel.genpressure)bad();
  return ()=>{
    for(const k of ids){const el=ui[k];if(el.type==='checkbox')el.checked=v.panel[k];else el.value=v.panel[k];el.dispatchEvent(new Event('input'));}
    for(const k of Object.keys(keys))delete keys[k];Object.assign(keys,v.held);
    autopilot=v.autopilot;apHeading=v.apHeading;
    Object.assign(gameSheet,v.game.sheet);Object.assign(gameSheetAt,v.game.at);gameTiller=v.game.tiller;gameCrew=v.game.crew;
  };
}
