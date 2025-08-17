// api/_db.js
let items = []; // { id, handle, twitter_url, pfp_url, created_at }

export function all(){
  return items;
}
export function addUnique(item){
  const id = item.id || item.handle;
  const i = items.findIndex(x => (x.id||x.handle) === id);
  if (i >= 0) {
    // update PFP if changed
    items[i] = { ...items[i], ...item };
    return items[i];
  }
  items.push(item);
  return item;
}
