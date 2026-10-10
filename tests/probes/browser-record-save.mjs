// Сохранение полного JSON через локальный сервер, без большого текстового поля.
export async function saveBrowserRecord(text) {
  const bytes=new TextEncoder().encode(text);
  const response=await fetch('/api/browser-record',{method:'POST',headers:{'Content-Type':'application/json'},body:bytes});
  const receipt=await response.json();
  if(!response.ok)throw new Error(receipt.error??'Не удалось сохранить запись в проект');
  const sha256=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),x=>x.toString(16).padStart(2,'0')).join('');
  if(!/^out\/acceptance\/browser-record-\d{8}-[a-f0-9]{12}\.json$/.test(receipt.file)||receipt.sha256!==sha256||receipt.bytes!==bytes.length)
    throw new Error('Квитанция сохранения не соответствует записи');
  return receipt;
}
