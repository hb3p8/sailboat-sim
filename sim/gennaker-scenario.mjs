// Явный диагностический сценарий обычной лодки; команды заданы временем модели.
export function gennakerScenario(search,minimumM) {
  const p=new URLSearchParams(search),name=p.get('physics-run');if(!name)return undefined;
  if(name!=='controls-v1')throw new Error('Неизвестный сценарий физики');
  const side=p.get('physics-side')??'plus',wake=Number(p.get('physics-wake')??1),speed=Number(p.get('physics-speed')??0);
  if(!['plus','minus'].includes(side)||![1,3].includes(wake)||![0,3].includes(speed))
    throw new Error('Сценарий требует борт plus/minus, wake 1/3 и ход 0/3 м/с');
  const sign=side==='plus'?1:-1,D=Math.PI/180;
  const commands=[{atS:0,gennakerUp:false,sheetM:minimumM,rudderDeg:0,hike:0},
    {atS:1/3,gennakerUp:true},{atS:5/6,sheetM:minimumM+.25},
    {atS:5/3,sheetM:minimumM},{atS:2,rudderDeg:sign*4},{atS:2.5,hike:sign*.3}];
  let startS,applied=0,command={};
  return {name,side,wakeSlice:wake,initialSpeedMPS:speed,durationS:3,commands,
    reset(){startS=undefined;applied=0;command={};this.elapsedS=0;},
    get done(){return startS!==undefined&&this.elapsedS>=3-1e-10;},elapsedS:0,
    apply(boat,ui) {
      if(startS===undefined){startS=boat.t;boat.x=1355;boat.y=800;boat.psi=0;boat.u=speed;boat.v=0;}
      this.elapsedS=boat.t-startS;
      while(applied<commands.length&&commands[applied].atS<=this.elapsedS+1e-10)Object.assign(command,commands[applied++]);
      const o=boat.o;o.windSpeed=4;o.windDir=sign*140*D;o.wakeSlice=wake;
      o.crewMass=220;o.crewHike=command.hike;o.sheet=25*D;o.jibSheet=25*D;
      o.twist=8*D;o.jibTwist=8*D;o.draft=1;o.jibDraft=1;o.sailScale=1;
      boat.wind.o.gust=0;boat.wind.o.shift=0;o.rudderTarget=command.rudderDeg*D;
      o.genSheetLen=command.sheetM;o.mainUp=true;o.localPressure=false;
      if(!!o.gennakerUp!==command.gennakerUp)boat.setGennaker(command.gennakerUp);
      // Панель не должна отменить команду следующего шага.
      ui.genup.checked=o.gennakerUp;ui.jibup.checked=!!o.jibUp;ui.mainup.checked=true;
      for(const [key,value] of Object.entries({mainsheet:25,jibsheet:25,twist:8,jibtwist:8,draft:100,jibdraft:100,sailscale:1,gust:0}))if(ui[key]){ui[key].value=String(value);ui[key].dispatchEvent(new Event('input'));}
      ui.wind.value='4';ui.winddir.value=String((sign*140+360)%360);ui.gensheet.value=String(command.sheetM);
      for(const key of ['wind','winddir','gensheet'])ui[key].dispatchEvent(new Event('input'));
    },
    accepted(boat){this.elapsedS=boat.t-startS;},
    snapshot(){return {name,side,wakeSlice:wake,initialSpeedMPS:speed,durationS:3,elapsedS:this.elapsedS,applied,
      conditions:{windMPS:4,mainSheetDeg:25,jibSheetDeg:25,twistDeg:8,crewKg:220,gust:0},
      commands:commands.map(c=>({...c})),command:{...command},done:this.done};}
  };
}
