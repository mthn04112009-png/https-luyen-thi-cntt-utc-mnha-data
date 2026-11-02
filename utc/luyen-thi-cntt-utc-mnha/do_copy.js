const fs = require('fs');
const src = 'C:\\Users\\Admin\\Downloads\\claude\\luyen-thi-cntt-utc-mnha\\video.controller.js';
const dst = 'C:\\Users\\Admin\\Downloads\\claude\\luyen-thi-cntt-utc-mnha\\luyen-thi-cntt-utc-mnha\\luyen-thi-cntt-utc-mnha\\controllers\\video.controller.js';
fs.copyFileSync(src, dst);
console.log('ok');
