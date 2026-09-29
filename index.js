require('dotenv').config();
const express=require('express');
const fs=require('fs');
const path=require('path');
const cookieParser=require('cookie-parser');
const jwt=require('jsonwebtoken');
const {Pool}=require('pg');
const {Telegraf,Markup}=require('telegraf');

const REQUIRED=['BOT_TOKEN','DATABASE_URL','JWT_SECRET','WEBHOOK_SECRET','BASE_URL','ADMIN_USERNAME','ADMIN_PASSWORD'];
for(const k of REQUIRED) if(!process.env[k]) throw new Error('Missing '+k);

const db=new Pool({connectionString:process.env.DATABASE_URL,ssl:{rejectUnauthorized:false},max:10});
const q=(sql,params=[])=>db.query(sql,params);
const bot=new Telegraf(process.env.BOT_TOKEN);

const SQL=`
CREATE TABLE IF NOT EXISTS users(
 id BIGSERIAL PRIMARY KEY, telegram_id BIGINT UNIQUE NOT NULL, username TEXT, first_name TEXT,
 referred_by BIGINT REFERENCES users(id), balance NUMERIC(14,2) DEFAULT 0, lifetime_earned NUMERIC(14,2) DEFAULT 0,
 lifetime_withdrawn NUMERIC(14,2) DEFAULT 0, status TEXT DEFAULT 'active', created_at TIMESTAMPTZ DEFAULT NOW(), last_seen_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS channels(
 id BIGSERIAL PRIMARY KEY, title TEXT NOT NULL, chat_id TEXT UNIQUE NOT NULL, username TEXT, invite_url TEXT,
 verification_required BOOLEAN DEFAULT TRUE, active BOOLEAN DEFAULT TRUE, sort_order INT DEFAULT 0, created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS tasks(
 id BIGSERIAL PRIMARY KEY, title TEXT NOT NULL, description TEXT DEFAULT '', reward NUMERIC(14,2) NOT NULL DEFAULT 0,
 daily_limit INT DEFAULT 1, active BOOLEAN DEFAULT TRUE, created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS task_attempts(
 id BIGSERIAL PRIMARY KEY, task_id BIGINT REFERENCES tasks(id), user_id BIGINT REFERENCES users(id), status TEXT DEFAULT 'started',
 created_at TIMESTAMPTZ DEFAULT NOW(), completed_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS wallet_transactions(
 id BIGSERIAL PRIMARY KEY, user_id BIGINT REFERENCES users(id), type TEXT NOT NULL, amount NUMERIC(14,2) NOT NULL,
 status TEXT DEFAULT 'confirmed', reference TEXT, note TEXT, created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS referrals(
 id BIGSERIAL PRIMARY KEY, referrer_id BIGINT REFERENCES users(id), referred_id BIGINT UNIQUE REFERENCES users(id),
 status TEXT DEFAULT 'pending', reward NUMERIC(14,2) DEFAULT 0, qualified_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS withdrawals(
 id BIGSERIAL PRIMARY KEY, user_id BIGINT REFERENCES users(id), amount NUMERIC(14,2) NOT NULL, method TEXT NOT NULL,
 destination TEXT NOT NULL, status TEXT DEFAULT 'pending', note TEXT, created_at TIMESTAMPTZ DEFAULT NOW(), processed_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS gift_codes(
 id BIGSERIAL PRIMARY KEY, code TEXT UNIQUE NOT NULL, amount NUMERIC(14,2) NOT NULL, max_uses INT DEFAULT 1,
 used_count INT DEFAULT 0, active BOOLEAN DEFAULT TRUE, expires_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS gift_uses(id BIGSERIAL PRIMARY KEY,gift_id BIGINT REFERENCES gift_codes(id),user_id BIGINT REFERENCES users(id),created_at TIMESTAMPTZ DEFAULT NOW(),UNIQUE(gift_id,user_id));
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT);
CREATE TABLE IF NOT EXISTS broadcasts(id BIGSERIAL PRIMARY KEY,kind TEXT NOT NULL,text TEXT,media_file_id TEXT,caption TEXT,audience TEXT DEFAULT 'all',sent INT DEFAULT 0,failed INT DEFAULT 0,status TEXT DEFAULT 'pending',created_at TIMESTAMPTZ DEFAULT NOW());
CREATE TABLE IF NOT EXISTS audit_logs(id BIGSERIAL PRIMARY KEY,admin_username TEXT,action TEXT,details JSONB,created_at TIMESTAMPTZ DEFAULT NOW());
INSERT INTO settings(key,value) VALUES
 ('currency','₹'),('min_withdrawal','100'),('referral_reward','10'),('referral_qualify_task','1'),
 ('start_image_file_id',''),('start_title','👋 Welcome to Falak Agent'),
 ('start_text','🎁 Complete tasks\\n👥 Invite friends\\n💰 Earn rewards\\n💸 Withdraw your earnings\\n\\nJoin the channels below to unlock the bot.'),
 ('maintenance','0'),('updates_url',''),('privacy_url',''),('language_url',''),('report_url',''),('rate_url','') ON CONFLICT(key) DO NOTHING;
`;

async function setting(k,d=''){const r=await q('SELECT value FROM settings WHERE key=$1',[k]);return r.rows[0]?.value??d;}
async function setSetting(k,v){await q('INSERT INTO settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value',[k,String(v)]);}
function esc(s){return String(s??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
function money(n,c='₹'){return c+Number(n||0).toFixed(2);}
function mainMenu(){return Markup.inlineKeyboard([
 [Markup.button.callback('🎁 Earn','ui:tasks'),Markup.button.callback('💰 Wallet','ui:wallet')],
 [Markup.button.callback('👥 Invite & Earn','ui:invite'),Markup.button.callback('🏆 Leaderboard','ui:leaderboard')],
 [Markup.button.callback('🎟 Gift Code','ui:gift'),Markup.button.callback('📜 History','ui:history')],
 [Markup.button.callback('💸 Withdraw','ui:withdraw'),Markup.button.callback('👤 My Account','ui:account')],
 [Markup.button.callback('🆘 Support','ui:support')]
]);}
function homeLinks(){
  // Keep the welcome screen focused on the reward bot itself.
  // No unrelated Add-to-Group / Rate / Updates buttons.
  return Markup.inlineKeyboard([
    [Markup.button.callback('🎁 Earn','ui:tasks'),Markup.button.callback('💰 Wallet','ui:wallet')],
    [Markup.button.callback('👥 Invite & Earn','ui:invite'),Markup.button.callback('🏆 Leaderboard','ui:leaderboard')],
    [Markup.button.callback('🎟 Gift Code','ui:gift'),Markup.button.callback('📜 History','ui:history')],
    [Markup.button.callback('💸 Withdraw','ui:withdraw'),Markup.button.callback('👤 My Account','ui:account')],
    [Markup.button.callback('🆘 Support','ui:support')]
  ]);
}


function channelRows(cs){
  const buttons=cs.map(c=>{
    const rawInvite=String(c.invite_url||'').trim();
    const uname=String(c.username||'').replace(/^@/,'').trim();
    const url=rawInvite || (uname ? `https://t.me/${uname}` : '');
    const label=(c.verification_required?'🔒 ':'📢 ')+c.title;
    return url ? Markup.button.url(label,url) : Markup.button.callback(label,`channelinfo:${c.id}`);
  });
  const rows=[];
  for(let i=0;i<buttons.length;i+=3) rows.push(buttons.slice(i,i+3));
  return rows;
}
async function getUser(id){return (await q('SELECT * FROM users WHERE telegram_id=$1',[id])).rows[0];}
async function ensureUser(from,payload){
 let u=await getUser(from.id); if(u){await q('UPDATE users SET username=$2,first_name=$3,last_seen_at=NOW() WHERE id=$1',[u.id,from.username||null,from.first_name||'']);return (await getUser(from.id));}
 let ref=null;
 if(payload?.startsWith('ref_')){const tid=Number(payload.slice(4));if(Number.isSafeInteger(tid)&&tid!==from.id){ref=(await q('SELECT id FROM users WHERE telegram_id=$1',[tid])).rows[0]?.id||null;}}
 const r=await q('INSERT INTO users(telegram_id,username,first_name,referred_by) VALUES($1,$2,$3,$4) RETURNING *',[from.id,from.username||null,from.first_name||'',ref]);
 if(ref) await q('INSERT INTO referrals(referrer_id,referred_id) VALUES($1,$2) ON CONFLICT(referred_id) DO NOTHING',[ref,r.rows[0].id]);
 await notifyAdminNewUser(r.rows[0],ref);
 return r.rows[0];
}
async function notifyAdminNewUser(user,referrerId){
 const adminId=process.env.ADMIN_CHAT_ID;
 if(!adminId)return;
 try{
   let refText='None';
   if(referrerId){const rr=(await q('SELECT telegram_id,username,first_name FROM users WHERE id=$1',[referrerId])).rows[0];if(rr)refText=`${rr.first_name||''}${rr.username?' (@'+rr.username+')':''} [${rr.telegram_id}]`.trim();}
   const name=esc(user.first_name||'Unknown');
   const username=user.username?`@${esc(user.username)}`:'—';
   const text=`🆕 <b>NEW USER</b>

👤 <b>Name:</b> ${name}
🔹 <b>Username:</b> ${username}
🆔 <b>Telegram ID:</b> <code>${user.telegram_id}</code>
🔗 <b>Referral:</b> ${esc(refText)}
🕐 <b>Joined:</b> ${esc(new Date().toISOString())}`;
   await bot.telegram.sendMessage(adminId,text,{parse_mode:'HTML'});
 }catch(e){console.error('Admin new-user notification failed:',e.message);}
}
async function requiredChannels(){return (await q('SELECT * FROM channels WHERE active ORDER BY sort_order,id')).rows;}
async function isMember(ctx,c){try{const m=await ctx.telegram.getChatMember(c.chat_id,ctx.from.id);return ['creator','administrator','member'].includes(m.status)||(m.status==='restricted'&&m.is_member===true);}catch{return false;}}
async function isVerified(ctx){for(const c of await requiredChannels()){if(c.verification_required && !(await isMember(ctx,c)))return false;}return true;}
async function sendGate(ctx){
 const cs=await requiredChannels();
 const required=cs.filter(c=>c.verification_required);
 if(!required.length){return true;}
 const missing=[];for(const c of required)if(!(await isMember(ctx,c)))missing.push(c);
 if(!missing.length)return true;
 const rows=channelRows(missing);rows.push([Markup.button.callback('🔄 VERIFY MEMBERSHIP','verify')]);
 await ctx.reply('🔐 <b>Join Required Channels</b>\n\nJoin the channels marked 🔒 and then press <b>VERIFY MEMBERSHIP</b>.\n\nOptional channels are shown but do not block access.',{parse_mode:'HTML',...Markup.inlineKeyboard(rows)});
 return false;
}
async function qualifyReferral(userId){
 const ref=(await q("SELECT r.*,u.id referrer_id,u.telegram_id referrer_tid FROM referrals r JOIN users u ON u.id=r.referrer_id WHERE r.referred_id=$1 AND r.status='pending'",[userId])).rows[0];
 if(!ref)return;
 const minTask=Number(await setting('referral_qualify_task','1'));
 const activity=Number((await q("SELECT count(*)::int n FROM task_attempts WHERE user_id=$1 AND status='completed'",[userId])).rows[0].n);
 if(activity<minTask)return;
 const reward=Number(await setting('referral_reward','10'));const c=await db.connect();
 try{await c.query('BEGIN');const lock=(await c.query("SELECT status FROM referrals WHERE id=$1 FOR UPDATE",[ref.id])).rows[0];if(!lock||lock.status!=='pending'){await c.query('ROLLBACK');return;}
 await c.query("UPDATE referrals SET status='qualified',reward=$2,qualified_at=NOW() WHERE id=$1",[ref.id,reward]);
 await c.query('UPDATE users SET balance=balance+$2,lifetime_earned=lifetime_earned+$2 WHERE id=$1',[ref.referrer_id,reward]);
 await c.query("INSERT INTO wallet_transactions(user_id,type,amount,reference,note) VALUES($1,'referral_reward',$2,$3,$4)",[ref.referrer_id,reward,'REF-'+ref.id,'Qualified referral']);
 await c.query('COMMIT');
 try{await bot.telegram.sendMessage(ref.referrer_tid,`🎉 <b>Referral Qualified!</b>\n\nYou earned <b>${esc(money(reward,await setting('currency','₹')))}</b> from a qualified referral.`,{parse_mode:'HTML'});}catch{}
 }catch(e){await c.query('ROLLBACK');}finally{c.release();}
}
async function home(ctx){const u=await getUser(ctx.from.id),cur=await setting('currency','₹'),me=await ctx.telegram.getMe();const text=`🏠 <b>Falak Rewards</b>\n\n💰 <b>Balance:</b> ${esc(money(u.balance,cur))}\n🎁 <b>Lifetime earned:</b> ${esc(money(u.lifetime_earned,cur))}\n\nChoose an option below.`;const img=await setting('start_image_file_id','');const kb=mainMenu();if(img){try{return await ctx.replyWithPhoto(img,{caption:text,parse_mode:'HTML',...kb});}catch{}}return ctx.reply(text,{parse_mode:'HTML',...kb});}

async function sendStart(ctx){
 const img=await setting('start_image_file_id','');const title=await setting('start_title','👋 Welcome to Falak Rewards');const body=(await setting('start_text','')).replace(/\\n/g,'\n');
 const text=`<b>${esc(title)}</b>\n\n${esc(body)}`;
 const cs=await requiredChannels();const rows=channelRows(cs);
 if(cs.some(c=>c.verification_required))rows.push([Markup.button.callback('🔄 VERIFY MEMBERSHIP','verify')]);
 const me=await ctx.telegram.getMe();
 const keyboard=Markup.inlineKeyboard([...rows,...homeLinks().reply_markup.inline_keyboard]);
 if(img){try{return await ctx.replyWithPhoto(img,{caption:text,parse_mode:'HTML',...keyboard});}catch(e){console.error('Welcome image failed:',e.message);}}
 return ctx.reply(text,{parse_mode:'HTML',...keyboard});
}

function extractStartPayload(ctx){
  const text=ctx.message?.text||'';
  const m=text.match(/^\/start(?:@[A-Za-z0-9_]+)?(?:\s+([^\s]+))?/i);
  return m?.[1]||'';
}
bot.use(async(ctx,next)=>{if(ctx.from)await ensureUser(ctx.from,extractStartPayload(ctx));return next();});
bot.start(async ctx=>{if((await setting('maintenance','0'))==='1')return ctx.reply('🛠 <b>Maintenance Mode</b>\nPlease try again later.',{parse_mode:'HTML'});if(await isVerified(ctx))return home(ctx);return sendStart(ctx);});
bot.action(/^channelinfo:(\d+)$/,async ctx=>{await ctx.answerCbQuery('This channel has no join link configured.',{show_alert:true});});
bot.action('verify',async ctx=>{await ctx.answerCbQuery();if(await sendGate(ctx))return home(ctx);});

async function showTasks(ctx){return gated(ctx,async()=>{const ts=(await q('SELECT * FROM tasks WHERE active ORDER BY id DESC')).rows;if(!ts.length)return ctx.reply('📭 <b>No tasks available right now.</b>\nPlease check again later.',{parse_mode:'HTML',...mainMenu()});for(const t of ts){const text=`🎁 <b>${esc(t.title)}</b>\n\n${esc(t.description)}\n\n💰 Reward: <b>${esc(money(t.reward,await setting('currency','₹')))}</b>`;await ctx.reply(text,{parse_mode:'HTML',...Markup.inlineKeyboard([[Markup.button.callback('🚀 START TASK',`task:${t.id}`)],[Markup.button.callback('‹ BACK','ui:home')]])});}});}
async function showWallet(ctx){return gated(ctx,async()=>{const u=await getUser(ctx.from.id),c=await setting('currency','₹');await ctx.reply(`💰 <b>MY WALLET</b>\n\nAvailable Balance\n<b>${esc(money(u.balance,c))}</b>\n\n🎁 Lifetime Earned: ${esc(money(u.lifetime_earned,c))}\n💸 Lifetime Withdrawn: ${esc(money(u.lifetime_withdrawn,c))}`,{parse_mode:'HTML',...mainMenu()});});}
async function showAccount(ctx){return gated(ctx,async()=>{const u=await getUser(ctx.from.id);const s=(await q("SELECT count(*)::int total,count(*) FILTER(WHERE status='qualified')::int qualified FROM referrals WHERE referrer_id=$1",[u.id])).rows[0];await ctx.reply(`👤 <b>MY ACCOUNT</b>\n\n🆔 <code>${u.telegram_id}</code>\n${u.username?'@'+esc(u.username):'No username'}\n\n👥 Invited: <b>${s.total}</b>\n✅ Qualified: <b>${s.qualified}</b>\n📅 Joined: ${new Date(u.created_at).toLocaleDateString('en-IN')}`,{parse_mode:'HTML',...mainMenu()});});}
async function showInvite(ctx){return gated(ctx,async()=>{const u=await getUser(ctx.from.id),me=await ctx.telegram.getMe(),c=await setting('currency','₹');const s=(await q("SELECT count(*)::int total,count(*) FILTER(WHERE status='qualified')::int qualified,coalesce(sum(reward),0) earned FROM referrals WHERE referrer_id=$1",[u.id])).rows[0];const link=`https://t.me/${me.username}?start=ref_${ctx.from.id}`;await ctx.reply(`👥 <b>INVITE &amp; EARN</b>\n\n💰 Reward per qualified referral: <b>${esc(money(await setting('referral_reward','10'),c))}</b>\n\n👤 Invited: <b>${s.total}</b>\n✅ Qualified: <b>${s.qualified}</b>\n💵 Referral Earnings: <b>${esc(money(s.earned,c))}</b>\n\n🔗 <b>Your referral link</b>\n<code>${esc(link)}</code>`,{parse_mode:'HTML',...Markup.inlineKeyboard([[Markup.button.url('📤 SHARE LINK',`https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent('Join Falak Rewards and start earning!')}`)],[Markup.button.callback('‹ BACK','ui:home')]])});});}
async function showLeaderboard(ctx){return gated(ctx,async()=>{const c=await setting('currency','₹');const r=(await q("SELECT first_name,username,lifetime_earned FROM users WHERE status='active' ORDER BY lifetime_earned DESC LIMIT 10")).rows;await ctx.reply('🏆 <b>TOP EARNERS</b>\n\n'+(r.length?r.map((x,i)=>`${['🥇','🥈','🥉'][i]||`${i+1}️⃣`} ${esc(x.username?'@'+x.username:x.first_name)} — <b>${esc(money(x.lifetime_earned,c))}</b>`).join('\n'):'No data yet.'),{parse_mode:'HTML',...mainMenu()});});}
async function showHistory(ctx){return gated(ctx,async()=>{const u=await getUser(ctx.from.id),r=(await q('SELECT type,amount,status,created_at FROM wallet_transactions WHERE user_id=$1 ORDER BY id DESC LIMIT 15',[u.id])).rows;const c=await setting('currency','₹');await ctx.reply(r.length?'📜 <b>HISTORY</b>\n\n'+r.map(x=>`• ${esc(x.type)} — ${esc(money(x.amount,c))} — ${esc(x.status)}`).join('\n'):'📜 No transactions yet.',{parse_mode:'HTML',...mainMenu()});});}
async function showGift(ctx){await ctx.answerCbQuery?.().catch(()=>{});return ctx.reply('🎟 <b>GIFT CODE</b>\n\nSend: <code>/gift YOURCODE</code>',{parse_mode:'HTML',...mainMenu()});}
async function showWithdraw(ctx){return gated(ctx,async()=>{const u=await getUser(ctx.from.id),m=await setting('min_withdrawal','100'),c=await setting('currency','₹');await ctx.reply(`💸 <b>WITHDRAW</b>\n\nAvailable: <b>${esc(money(u.balance,c))}</b>\nMinimum: <b>${esc(money(m,c))}</b>\n\nUse:\n<code>/withdraw ${m} upi yourupi@bank</code>`,{parse_mode:'HTML',...mainMenu()});});}
async function showSupport(ctx){return ctx.reply(`🆘 <b>SUPPORT</b>\n\nContact: @${esc(String(process.env.SUPPORT_USERNAME||'not_configured').replace(/^@/,''))}`,{parse_mode:'HTML',...mainMenu()});}
async function showHelp(ctx){return ctx.reply('📖 <b>HELP</b>\n\nUse the buttons above to navigate.\n\n/gift CODE — redeem a gift code\n/withdraw amount method destination — request a withdrawal\n/start — open the welcome screen.',{parse_mode:'HTML',...mainMenu()});}
async function showHome(ctx){return home(ctx);}

bot.action(/^ui:(home|tasks|wallet|invite|leaderboard|gift|history|withdraw|account|support|help)$/,async ctx=>{await ctx.answerCbQuery();const a=ctx.match[1];if(a==='home')return showHome(ctx);if(a==='tasks')return showTasks(ctx);if(a==='wallet')return showWallet(ctx);if(a==='invite')return showInvite(ctx);if(a==='leaderboard')return showLeaderboard(ctx);if(a==='gift')return showGift(ctx);if(a==='history')return showHistory(ctx);if(a==='withdraw')return showWithdraw(ctx);if(a==='account')return showAccount(ctx);if(a==='support')return showSupport(ctx);return showHelp(ctx);});
bot.action(/^task:(\d+)$/,async ctx=>{await ctx.answerCbQuery();await gated(ctx,async()=>{const u=await getUser(ctx.from.id);const t=(await q('SELECT * FROM tasks WHERE id=$1 AND active',[Number(ctx.match[1])])).rows[0];if(!t)return ctx.reply('❌ Task unavailable.');const n=Number((await q("SELECT count(*)::int n FROM task_attempts WHERE user_id=$1 AND task_id=$2 AND created_at>=date_trunc('day',NOW()) AND status='completed'",[u.id,t.id])).rows[0].n);if(n>=t.daily_limit)return ctx.reply('⚠️ Daily limit reached.');const a=(await q('INSERT INTO task_attempts(task_id,user_id) VALUES($1,$2) RETURNING id',[t.id,u.id])).rows[0];await ctx.reply(`🚀 <b>${esc(t.title)}</b>\n\nComplete the task and then continue.`,{parse_mode:'HTML',...Markup.inlineKeyboard([[Markup.button.callback('✅ COMPLETE',`done:${a.id}`)],[Markup.button.callback('‹ BACK','ui:tasks')]])});});});
bot.action(/^done:(\d+)$/,async ctx=>{await ctx.answerCbQuery();const u=await getUser(ctx.from.id);const c=await db.connect();try{await c.query('BEGIN');const a=(await c.query('SELECT a.*,t.reward,t.title FROM task_attempts a JOIN tasks t ON t.id=a.task_id WHERE a.id=$1 AND a.user_id=$2 FOR UPDATE',[Number(ctx.match[1]),u.id])).rows[0];if(!a||a.status!=='started'){await c.query('ROLLBACK');return ctx.reply('❌ Invalid or already completed.');}await c.query("UPDATE task_attempts SET status='completed',completed_at=NOW() WHERE id=$1",[a.id]);await c.query('UPDATE users SET balance=balance+$2,lifetime_earned=lifetime_earned+$2 WHERE id=$1',[u.id,a.reward]);await c.query("INSERT INTO wallet_transactions(user_id,type,amount,reference,note) VALUES($1,'task_reward',$2,$3,$4)",[u.id,a.reward,'TASK-'+a.id,a.title]);await c.query('COMMIT');await ctx.reply(`🎉 <b>Reward Added!</b>\n\nYou earned <b>${esc(money(a.reward,await setting('currency','₹')))}</b>.`,{parse_mode:'HTML',...mainMenu()});await qualifyReferral(u.id);}catch(e){await c.query('ROLLBACK');await ctx.reply('❌ Something went wrong.');}finally{c.release();}});

bot.command('gift',async ctx=>{const code=(ctx.message.text.split(/\s+/)[1]||'').toUpperCase();if(!code)return ctx.reply('Usage: /gift CODE');const u=await getUser(ctx.from.id),c=await db.connect();try{await c.query('BEGIN');const g=(await c.query('SELECT * FROM gift_codes WHERE code=$1 AND active FOR UPDATE',[code])).rows[0];if(!g)throw Error('Invalid code');if(g.expires_at&&new Date(g.expires_at)<new Date())throw Error('Code expired');if(g.used_count>=g.max_uses)throw Error('No uses left');if((await c.query('SELECT 1 FROM gift_uses WHERE gift_id=$1 AND user_id=$2',[g.id,u.id])).rows[0])throw Error('Already used');await c.query('INSERT INTO gift_uses(gift_id,user_id) VALUES($1,$2)',[g.id,u.id]);await c.query('UPDATE gift_codes SET used_count=used_count+1 WHERE id=$1',[g.id]);await c.query('UPDATE users SET balance=balance+$2,lifetime_earned=lifetime_earned+$2 WHERE id=$1',[u.id,g.amount]);await c.query("INSERT INTO wallet_transactions(user_id,type,amount,reference) VALUES($1,'gift_code',$2,$3)",[u.id,g.amount,'GIFT-'+g.id]);await c.query('COMMIT');await ctx.reply(`🎉 <b>Gift Code Applied!</b>\n\nAdded <b>${esc(money(g.amount,await setting('currency','₹')))}</b> to your wallet.`,{parse_mode:'HTML',...mainMenu()});await qualifyReferral(u.id);}catch(e){await c.query('ROLLBACK');await ctx.reply('❌ '+esc(e.message),{parse_mode:'HTML'});}finally{c.release();}});
bot.command('help',async ctx=>showHelp(ctx));
bot.command('withdraw',async ctx=>{if(!(await isVerified(ctx)))return sendGate(ctx);const p=ctx.message.text.trim().split(/\s+/),amount=Number(p[1]),method=p[2],dest=p.slice(3).join(' '),min=Number(await setting('min_withdrawal','100')),u=await getUser(ctx.from.id);if(!Number.isFinite(amount)||amount<min||!method||!dest)return ctx.reply(`Usage: /withdraw ${min} upi yourupi@bank`);const c=await db.connect();try{await c.query('BEGIN');const bal=Number((await c.query('SELECT balance FROM users WHERE id=$1 FOR UPDATE',[u.id])).rows[0].balance);if(bal<amount)throw Error('Insufficient balance');const w=(await c.query('INSERT INTO withdrawals(user_id,amount,method,destination) VALUES($1,$2,$3,$4) RETURNING id',[u.id,amount,method,dest])).rows[0];await c.query('UPDATE users SET balance=balance-$2 WHERE id=$1',[u.id,amount]);await c.query("INSERT INTO wallet_transactions(user_id,type,amount,status,reference) VALUES($1,'withdrawal',$2,'pending',$3)",[u.id,-amount,'WD-'+w.id]);await c.query('COMMIT');await ctx.reply(`⏳ <b>Withdrawal Submitted</b>\n\nRequest: <code>WD-${w.id}</code>\nAmount: <b>${esc(money(amount,await setting('currency','₹')))}</b>\nStatus: Pending`,{parse_mode:'HTML',...mainMenu()});}catch(e){await c.query('ROLLBACK');await ctx.reply('❌ '+esc(e.message),{parse_mode:'HTML'});}finally{c.release();}});

// Legacy text commands remain supported for users who type them manually.
bot.hears('🎁 Earn',showTasks);bot.hears('💰 Wallet',showWallet);bot.hears('👥 Invite & Earn',showInvite);bot.hears('🏆 Leaderboard',showLeaderboard);bot.hears('🎟 Gift Code',showGift);bot.hears('📜 History',showHistory);bot.hears('💸 Withdraw',showWithdraw);bot.hears('👤 My Account',showAccount);bot.hears('🆘 Support',showSupport);


const welcomePhotoAdmins=new Set();
async function isAdminTelegram(id){return String(id)===String(process.env.ADMIN_CHAT_ID||'');}
bot.command('setwelcome',async ctx=>{if(!(await isAdminTelegram(ctx.from.id)))return;welcomePhotoAdmins.add(String(ctx.from.id));await ctx.reply('🖼 Send the welcome poster photo now. I will save its Telegram file_id and use it on /start.');});
bot.command('clearwelcome',async ctx=>{if(!(await isAdminTelegram(ctx.from.id)))return;welcomePhotoAdmins.delete(String(ctx.from.id));await setSetting('start_image_file_id','');await ctx.reply('✅ Welcome poster cleared.');});
bot.on('photo',async ctx=>{if(!welcomePhotoAdmins.has(String(ctx.from.id))||!(await isAdminTelegram(ctx.from.id)))return;const photo=ctx.message.photo.at(-1);if(!photo)return;await setSetting('start_image_file_id',photo.file_id);welcomePhotoAdmins.delete(String(ctx.from.id));await ctx.reply('✅ Welcome poster saved. Send /start to preview it.');});


const app=express();app.use(express.json({limit:'2mb'}));app.use(cookieParser());
app.get('/health',(req,res)=>res.json({ok:true,service:'falak-agent-reward-bot'}));
function auth(req,res,next){try{req.admin=jwt.verify(req.cookies.admin,process.env.JWT_SECRET);next();}catch{res.status(401).json({error:'Unauthorized'});}}
function page(){return fs.readFileSync(path.join(__dirname,'admin.html'),'utf8');}
app.get('/admin',(req,res)=>res.send(page()));
app.post('/admin/login',(req,res)=>{if(req.body.username!==process.env.ADMIN_USERNAME||req.body.password!==process.env.ADMIN_PASSWORD)return res.status(401).json({error:'Invalid login'});res.cookie('admin',jwt.sign({u:req.body.username},process.env.JWT_SECRET,{expiresIn:'12h'}),{httpOnly:true,secure:true,sameSite:'lax'});res.json({ok:true});});
app.post('/admin/logout',(req,res)=>{res.clearCookie('admin');res.json({ok:true});});
app.get('/admin/api/session',auth,(req,res)=>res.json({ok:true,admin:req.admin.u}));
app.get('/admin/api/stats',auth,async(req,res)=>{const a=await q('SELECT count(*)::int n FROM users'),b=await q('SELECT count(*)::int n FROM tasks'),c=await q('SELECT count(*)::int n FROM channels WHERE active'),d=await q("SELECT count(*)::int n FROM withdrawals WHERE status='pending'");res.json({users:a.rows[0].n,tasks:b.rows[0].n,channels:c.rows[0].n,pending:d.rows[0].n});});
app.get('/admin/api/settings',auth,async(req,res)=>{const r=await q('SELECT key,value FROM settings');res.json(Object.fromEntries(r.rows.map(x=>[x.key,x.value])));});
app.post('/admin/api/settings',auth,async(req,res)=>{for(const [k,v] of Object.entries(req.body||{}))await setSetting(k,v);await q('INSERT INTO audit_logs(admin_username,action,details) VALUES($1,$2,$3)',[req.admin.u,'settings.update',req.body]);res.json({ok:true});});
app.get('/admin/api/channels',auth,async(req,res)=>res.json((await q('SELECT * FROM channels ORDER BY sort_order,id')).rows));
app.post('/admin/api/channels',auth,async(req,res)=>{const title=String(req.body.title||'').trim(),chatId=String(req.body.chat_id||'').trim(),username=String(req.body.username||'').trim().replace(/^@/,'')||null,invite=String(req.body.invite_url||'').trim()||null;if(!title||!chatId)return res.status(400).json({error:'Title and Chat ID are required'});if(!invite&&!username)return res.status(400).json({error:'Add a public username or an invite URL so users can join the channel'});try{const r=await q('INSERT INTO channels(title,chat_id,username,invite_url,verification_required,active) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',[title,chatId,username,invite,req.body.verification_required!==false,req.body.active!==false]);res.json(r.rows[0]);}catch(e){res.status(400).json({error:e.message});}});
app.put('/admin/api/channels/:id',auth,async(req,res)=>{const title=String(req.body.title||'').trim(),chatId=String(req.body.chat_id||'').trim(),username=String(req.body.username||'').trim().replace(/^@/,'')||null,invite=String(req.body.invite_url||'').trim()||null;if(!title||!chatId)return res.status(400).json({error:'Title and Chat ID are required'});if(!invite&&!username)return res.status(400).json({error:'Add a public username or an invite URL so users can join the channel'});try{const r=await q('UPDATE channels SET title=$2,chat_id=$3,username=$4,invite_url=$5,verification_required=$6,active=$7 WHERE id=$1 RETURNING *',[req.params.id,title,chatId,username,invite,req.body.verification_required!==false,req.body.active!==false]);res.json(r.rows[0]);}catch(e){res.status(400).json({error:e.message});}});
app.delete('/admin/api/channels/:id',auth,async(req,res)=>{await q('DELETE FROM channels WHERE id=$1',[req.params.id]);res.json({ok:true});});
app.get('/admin/api/tasks',auth,async(req,res)=>res.json((await q('SELECT * FROM tasks ORDER BY id DESC')).rows));
app.post('/admin/api/tasks',auth,async(req,res)=>{const r=await q('INSERT INTO tasks(title,description,reward,daily_limit) VALUES($1,$2,$3,$4) RETURNING *',[req.body.title,req.body.description||'',Number(req.body.reward),Number(req.body.daily_limit||1)]);res.json(r.rows[0]);});
app.get('/admin/api/gifts',auth,async(req,res)=>res.json((await q('SELECT * FROM gift_codes ORDER BY id DESC')).rows));
app.post('/admin/api/gifts',auth,async(req,res)=>{const r=await q('INSERT INTO gift_codes(code,amount,max_uses) VALUES($1,$2,$3) RETURNING *',[String(req.body.code).toUpperCase(),Number(req.body.amount),Number(req.body.max_uses||1)]);res.json(r.rows[0]);});
app.get('/admin/api/withdrawals',auth,async(req,res)=>res.json((await q('SELECT w.*,u.telegram_id,u.username FROM withdrawals w JOIN users u ON u.id=w.user_id ORDER BY w.id DESC LIMIT 200')).rows));
app.post('/admin/api/withdrawals/:id/pay',auth,async(req,res)=>{const c=await db.connect();try{await c.query('BEGIN');const w=(await c.query('SELECT * FROM withdrawals WHERE id=$1 FOR UPDATE',[req.params.id])).rows[0];if(!w||w.status!=='pending')throw Error('Not pending');await c.query("UPDATE withdrawals SET status='paid',processed_at=NOW() WHERE id=$1",[w.id]);await c.query('UPDATE users SET lifetime_withdrawn=lifetime_withdrawn+$2 WHERE id=$1',[w.user_id,w.amount]);await c.query("UPDATE wallet_transactions SET status='confirmed' WHERE reference=$1",['WD-'+w.id]);await c.query('COMMIT');await q('INSERT INTO audit_logs(admin_username,action,details) VALUES($1,$2,$3)',[req.admin.u,'withdrawal.paid',{id:w.id}]);res.json({ok:true});}catch(e){await c.query('ROLLBACK');res.status(400).json({error:e.message});}finally{c.release();}});
app.post('/admin/api/withdrawals/:id/reject',auth,async(req,res)=>{const c=await db.connect();try{await c.query('BEGIN');const w=(await c.query('SELECT * FROM withdrawals WHERE id=$1 FOR UPDATE',[req.params.id])).rows[0];if(!w||w.status!=='pending')throw Error('Not pending');await c.query("UPDATE withdrawals SET status='rejected',note=$2,processed_at=NOW() WHERE id=$1",[w.id,req.body.note||'Rejected']);await c.query('UPDATE users SET balance=balance+$2 WHERE id=$1',[w.user_id,w.amount]);await c.query("INSERT INTO wallet_transactions(user_id,type,amount,reference,note) VALUES($1,'refund',$2,$3,$4)",[w.user_id,w.amount,'REFUND-'+w.id,req.body.note||'Rejected withdrawal']);await c.query('COMMIT');await q('INSERT INTO audit_logs(admin_username,action,details) VALUES($1,$2,$3)',[req.admin.u,'withdrawal.rejected',{id:w.id}]);res.json({ok:true});}catch(e){await c.query('ROLLBACK');res.status(400).json({error:e.message});}finally{c.release();}});

app.post('/admin/api/broadcast',auth,async(req,res)=>{const kind=req.body.kind||'text',aud=req.body.audience||'all';let where="status='active'";if(aud==='balance')where+=" AND balance>0";if(aud==='verified')where+=" AND id IN (SELECT DISTINCT user_id FROM wallet_transactions)";const users=(await q('SELECT id,telegram_id FROM users WHERE '+where)).rows;const b=(await q('INSERT INTO broadcasts(kind,text,media_file_id,caption,audience,status) VALUES($1,$2,$3,$4,$5,$6) RETURNING id',[kind,req.body.text||'',req.body.media_file_id||null,req.body.text||'',aud,'sending'])).rows[0];let sent=0,failed=0;for(const u of users){try{if(kind==='photo')await bot.telegram.sendPhoto(u.telegram_id,req.body.media_file_id,{caption:req.body.text||''});else if(kind==='video')await bot.telegram.sendVideo(u.telegram_id,req.body.media_file_id,{caption:req.body.text||''});else await bot.telegram.sendMessage(u.telegram_id,req.body.text||'');sent++;}catch{failed++;}await new Promise(r=>setTimeout(r,35));}await q('UPDATE broadcasts SET sent=$2,failed=$3,status=$4 WHERE id=$1',[b.id,sent,failed,'completed']);await q('INSERT INTO audit_logs(admin_username,action,details) VALUES($1,$2,$3)',[req.admin.u,'broadcast.sent',{id:b.id,sent,failed}]);res.json({sent,failed});});

app.post('/telegram/webhook',async(req,res)=>{if(req.get('X-Telegram-Bot-Api-Secret-Token')!==process.env.WEBHOOK_SECRET)return res.sendStatus(401);try{await bot.handleUpdate(req.body);res.sendStatus(200);}catch(e){console.error(e);res.sendStatus(500);}});

(async()=>{await q(SQL);try{await bot.telegram.setMyCommands([{command:'start',description:'Open the welcome screen'},{command:'gift',description:'Redeem a gift code'},{command:'withdraw',description:'Request a withdrawal'},{command:'help',description:'Show help'}]);}catch(e){console.error('setMyCommands failed:',e.message);}const port=Number(process.env.PORT||3000);app.listen(port,async()=>{const base=process.env.BASE_URL.replace(/\/$/,'');const url=base+'/telegram/webhook';await bot.telegram.setWebhook(url,{secret_token:process.env.WEBHOOK_SECRET,allowed_updates:['message','callback_query']});console.log('READY',url);});})().catch(e=>{console.error(e);process.exit(1);});
