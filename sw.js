/* Chatbox service worker: PWA lifecycle and push notification display. */
self.addEventListener("install", function(event){ self.skipWaiting(); });
self.addEventListener("activate", function(event){ event.waitUntil(self.clients.claim()); });
self.addEventListener("push", function(event){
  var data={title:"Chatbox",body:"You have a new message.",url:"./"};
  try{ if(event.data){ var payload=event.data.json(); data=Object.assign(data,payload.notification||{},payload.data||{},payload); } }catch(e){ try{if(event.data)data.body=event.data.text();}catch(_){} }
  var title=String(data.title||"Chatbox");
  var options={body:String(data.body||"You have a new message."),icon:"./icon.svg",badge:"./icon.svg",tag:String(data.tag||"chatbox-message"),data:{url:String(data.url||"./")},renotify:false};
  event.waitUntil(self.registration.showNotification(title,options));
});
self.addEventListener("notificationclick", function(event){
  event.notification.close();
  var target=new URL((event.notification.data&&event.notification.data.url)||"./",self.location.href).href;
  event.waitUntil(self.clients.matchAll({type:"window",includeUncontrolled:true}).then(function(clients){
    for(var i=0;i<clients.length;i++){if("focus" in clients[i]&&clients[i].url.indexOf(self.location.origin)===0)return clients[i].focus().then(function(c){if("navigate" in c)return c.navigate(target);});}
    if(self.clients.openWindow)return self.clients.openWindow(target);
  }));
});
