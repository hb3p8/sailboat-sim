// Выбор единственного источника движения до начала цикла сцены.
export function liveSailEntry(search) {
  const query=new URLSearchParams(search);
  if(query.has('sail-live'))return {kind:'explicit',play:true,prefix:query.get('sail-live')};
  if(query.has('fluid-live'))return {kind:'review',play:false,prefix:query.get('fluid-live')};
  if(query.has('bench')||query.has('cloth-review')||query.has('legacy'))return undefined;
  return {kind:'simulator',play:false,manifestPath:'data/simulator/v1/manifest.json'};
}
