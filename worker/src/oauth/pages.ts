/**
 * The three pages a person sees while connecting an app: sign in, approve, and
 * "this can't be connected". Self-contained HTML (no framework, no external
 * assets), served by the Worker so the SPA need not know about OAuth.
 *
 * Every dynamic value goes through `escapeHtml`; the client's name in
 * particular is attacker-chosen text. The CSP allows only this page's own
 * nonce'd script and style, forbids framing (clickjacking an Approve button is
 * the attack that matters here) and forbids form submission outright: the
 * pages talk to the Worker with fetch(), and the final hop to the client's
 * redirect_uri is a script navigation, which `form-action` does not govern.
 * (Chrome applies `form-action` to a form POST's redirect chain, so a 302 to
 * claude.ai from a form would be blocked under it.)
 */
import { API_SECURITY } from "../cors.ts";
import type { McpScope } from "../mcp/principal.ts";
import { SCOPE_LABEL } from "./redirect.ts";

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function newNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export function pageHeaders(nonce: string): Record<string, string> {
  return {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Security-Policy": [
      "default-src 'none'",
      `script-src 'nonce-${nonce}'`,
      `style-src 'nonce-${nonce}'`,
      "connect-src 'self'",
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'",
    ].join("; "),
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "no-store",
    Pragma: "no-cache",
    ...API_SECURITY,
  };
}

export function pageResponse(html: string, nonce: string, status = 200): Response {
  return new Response(html, { status, headers: pageHeaders(nonce) });
}

const CSS = `
:root{color-scheme:light dark;--bg:#f7f6f4;--card:#fff;--ink:#22201e;--mute:#67615c;--line:#e3e0dc;--press:#b04528;--on-press:#fff;--bad:#a12a12;--soft:#f3d8cf}
@media (prefers-color-scheme:dark){:root{--bg:#181615;--card:#221f1d;--ink:#f1efec;--mute:#a39d97;--line:#3a3633;--press:#ec7c58;--on-press:#181615;--bad:#f3a58c;--soft:#3a2118}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;background:var(--bg);color:var(--ink);font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;display:flex;align-items:center;justify-content:center;padding:24px 16px}
main{width:100%;max-width:440px;background:var(--card);border:1px solid var(--line);border-radius:16px;padding:28px 24px}
.brand{font:600 15px/1 ui-serif,Georgia,serif;letter-spacing:.02em;color:var(--mute);margin:0 0 18px}
h1{font:600 22px/1.25 ui-serif,Georgia,serif;margin:0 0 12px}
p{margin:0 0 12px}
.mute{color:var(--mute);font-size:14px}
.app{font-weight:600}
.who{border:1px solid var(--line);border-radius:10px;padding:10px 12px;margin:14px 0;font-size:14px}
.who b{display:block;font-weight:600;font-size:12px;letter-spacing:.04em;text-transform:uppercase;color:var(--mute)}
ul{list-style:none;margin:12px 0;padding:0}
li{display:flex;gap:10px;padding:8px 0;border-top:1px solid var(--line);font-size:15px}
li:first-child{border-top:0}
li i{flex:none;width:8px;height:8px;margin-top:8px;border-radius:50%;background:var(--press)}
.never{background:var(--soft);border-radius:10px;padding:10px 12px;font-size:14px;margin:14px 0}
label.row{display:flex;gap:10px;align-items:flex-start;font-size:14px;margin:12px 0}
input[type=email]{width:100%;font:inherit;padding:11px 12px;border:1px solid var(--line);border-radius:10px;background:var(--bg);color:var(--ink);margin:6px 0 12px}
.actions{display:flex;gap:10px;margin-top:18px}
button{font:inherit;font-weight:600;border-radius:10px;padding:11px 16px;cursor:pointer;border:1px solid var(--line);background:transparent;color:var(--ink);flex:1}
button.go{background:var(--press);border-color:var(--press);color:var(--on-press)}
button.wide{width:100%;flex:none}
button:disabled{opacity:.55;cursor:default}
.msg{min-height:1.4em;font-size:14px;margin-top:12px;color:var(--mute)}
.msg.bad{color:var(--bad)}
.or{text-align:center;color:var(--mute);font-size:13px;margin:14px 0 2px}
`;

function layout(opts: {
  nonce: string;
  title: string;
  body: string;
  script?: string;
}): string {
  const script = opts.script
    ? `<script nonce="${opts.nonce}">${opts.script}</script>`
    : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(opts.title)}</title>
<style nonce="${opts.nonce}">${CSS}</style>
</head>
<body>
<main>
<p class="brand">Polarch</p>
${opts.body}
</main>
${script}
</body>
</html>`;
}

export function errorPage(nonce: string, opts: { title: string; message: string }): string {
  return layout({
    nonce,
    title: opts.title,
    body: `<h1>${escapeHtml(opts.title)}</h1>
<p>${escapeHtml(opts.message)}</p>
<p class="mute">Nothing was connected. You can close this tab and start again from the app.</p>`,
  });
}

const SIGN_IN_SCRIPT = `
(function(){
  var app=document.getElementById('app');
  var cb=app.getAttribute('data-callback');
  var errCb=app.getAttribute('data-error-callback');
  var form=document.getElementById('f');
  var email=document.getElementById('email');
  var btn=document.getElementById('send');
  var msg=document.getElementById('msg');
  function say(t,bad){msg.textContent=t;msg.className=bad?'msg bad':'msg';}
  function post(path,body){
    return fetch(path,{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  }
  form.addEventListener('submit',function(e){
    e.preventDefault();
    btn.disabled=true;say('Sending…');
    post('/api/auth/sign-in/magic-link',{email:email.value.trim(),callbackURL:cb}).then(function(r){
      if(r.ok){say('Check your email for a sign-in link, then open it on this device. It brings you straight back here.');}
      else if(r.status===429){say('Too many attempts. Wait a minute and try again.',true);btn.disabled=false;}
      else{say('Could not send the link. Check the address and try again.',true);btn.disabled=false;}
    }).catch(function(){say('Could not reach Polarch. Try again.',true);btn.disabled=false;});
  });
  var g=document.getElementById('google');
  if(g){g.addEventListener('click',function(){
    g.disabled=true;
    post('/api/auth/sign-in/social',{provider:'google',callbackURL:cb,errorCallbackURL:errCb}).then(function(r){return r.json();}).then(function(d){
      if(d&&d.url){location.assign(d.url);}else{say('Google sign-in is not available. Use the email link.',true);g.disabled=false;}
    }).catch(function(){say('Could not reach Polarch. Try again.',true);g.disabled=false;});
  });}
})();`;

export function signInPage(
  nonce: string,
  opts: { clientName: string; callbackUrl: string; errorCallbackUrl: string; google: boolean },
): string {
  return layout({
    nonce,
    title: "Sign in to Polarch",
    script: SIGN_IN_SCRIPT,
    body: `<div id="app" data-callback="${escapeHtml(opts.callbackUrl)}" data-error-callback="${escapeHtml(opts.errorCallbackUrl)}">
<h1>Sign in to connect an app</h1>
<p><span class="app">${escapeHtml(opts.clientName)}</span> wants to connect to your Polarch account. Sign in first, then you will be asked to approve it.</p>
<form id="f">
<label for="email" class="mute">Email</label>
<input id="email" type="email" required autocomplete="email" placeholder="you@example.com">
<button class="go wide" id="send" type="submit">Email me a sign-in link</button>
</form>
${opts.google ? `<p class="or">or</p><button id="google" class="wide" type="button">Continue with Google</button>` : ""}
<p class="msg" id="msg" role="status" aria-live="polite"></p>
<noscript><p class="msg bad">This page needs JavaScript.</p></noscript>
</div>`,
  });
}

const CONSENT_SCRIPT = `
(function(){
  var form=document.getElementById('f');
  var msg=document.getElementById('msg');
  var buttons=form.querySelectorAll('button');
  function lock(v){for(var i=0;i<buttons.length;i++){buttons[i].disabled=v;}}
  function send(decision){
    lock(true);
    var body=new URLSearchParams(new FormData(form));
    body.set('decision',decision);
    var w=document.getElementById('write');
    body.set('grant_write',w&&!w.checked?'0':'1');
    var pp=document.getElementById('people');
    body.set('grant_people',pp&&pp.checked?'1':'0');
    fetch('/oauth/authorize',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/x-www-form-urlencoded','accept':'application/json'},body:body.toString()})
    .then(function(r){return r.json().then(function(d){return d;});})
    .then(function(d){
      if(d&&d.redirect_to){msg.textContent=decision==='approve'?'Connecting…':'Cancelled.';location.assign(d.redirect_to);}
      else{msg.className='msg bad';msg.textContent=(d&&d.error_description)||'Something went wrong. Go back to the app and try again.';lock(false);}
    })
    .catch(function(){msg.className='msg bad';msg.textContent='Could not reach Polarch. Try again.';lock(false);});
  }
  document.getElementById('approve').addEventListener('click',function(){send('approve');});
  document.getElementById('deny').addEventListener('click',function(){send('deny');});
})();`;

export function consentPage(
  nonce: string,
  opts: {
    clientName: string;
    redirectLabel: string;
    email: string;
    scopes: McpScope[];
    /** Hidden fields echoed back on POST; the CSRF token binds them to this user. */
    fields: Record<string, string>;
  },
): string {
  const hidden = Object.entries(opts.fields)
    .map(([k, v]) => `<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(v)}">`)
    .join("\n");
  const items = opts.scopes
    .filter((s) => s.startsWith("agenda:"))
    .map((s) => `<li><i></i><span>${escapeHtml(SCOPE_LABEL[s])}</span></li>`)
    .join("");
  const wantsWrite = opts.scopes.includes("agenda:write");
  // People records are never part of the default. An app that asked for them
  // starts ticked; one that didn't can still be given them, by the person, here.
  const askedPeople = opts.scopes.some((s) => s.startsWith("people:"));
  return layout({
    nonce,
    title: "Connect an app to Polarch",
    script: CONSENT_SCRIPT,
    body: `<h1>Connect <span class="app">${escapeHtml(opts.clientName)}</span>?</h1>
<p class="mute">That name was chosen by the app itself; Polarch has not verified it. Only approve apps you started connecting just now.</p>
<div class="who"><b>Signed in as</b>${escapeHtml(opts.email)}</div>
<p>It will be able to:</p>
<ul>${items}</ul>
${wantsWrite ? `<label class="row"><input type="checkbox" id="write" checked><span>Allow it to make changes. Uncheck to let it read only.</span></label>` : ""}
<label class="row"><input type="checkbox" id="people"${askedPeople ? " checked" : ""}><span>Also let it see${wantsWrite ? " and update" : ""} the people you lead: health ratings, prayer, assessments, how-to-lead notes, wins, goals, past write-ups and transcripts.</span></label>
<p class="never">Unless that box is ticked, it can never see health ratings, prayer, assessments or how-to-lead notes about the people you lead.</p>
<p class="mute">After you choose, you are sent to ${escapeHtml(opts.redirectLabel)}. You can disconnect any time in Settings.</p>
<form id="f">
${hidden}
<div class="actions">
<button type="button" id="deny">Deny</button>
<button type="button" id="approve" class="go">Approve</button>
</div>
</form>
<p class="msg" id="msg" role="status" aria-live="polite"></p>
<noscript><p class="msg bad">This page needs JavaScript.</p></noscript>`,
  });
}
