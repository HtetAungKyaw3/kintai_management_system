"use strict";
// 使い方:  npm run create-user -- <メールアドレス> <氏名> [admin]
// パスワードは環境変数 PASSWORD で渡すか、実行中の入力で指定します（8文字以上）。
// 社員番号を付けるときは環境変数 EMP_NO を指定します（任意）。
const path = require("node:path");
const fs = require("node:fs");
const readline = require("node:readline");
const { openDb, hashPassword, normalizeEmail } = require("../db");

const [emailArg, name, roleArg] = process.argv.slice(2);
if (!emailArg || !name) {
  console.error("使い方: npm run create-user -- <メールアドレス> <氏名> [admin]");
  process.exit(1);
}
const email = normalizeEmail(emailArg);
if (!email) {
  console.error("メールアドレスの形式が正しくありません。");
  process.exit(1);
}
const empNo = process.env.EMP_NO ? String(process.env.EMP_NO).trim() : null;
if (empNo && !/^[A-Za-z0-9_-]{1,20}$/.test(empNo)) {
  console.error("社員番号は英数字・ハイフン・アンダースコアで20文字以内にしてください。");
  process.exit(1);
}
const role = roleArg === "admin" ? "admin" : "employee";
const dbFile = process.env.DB_FILE || path.join(__dirname, "..", "data", "timecard.db");
fs.mkdirSync(path.dirname(dbFile), { recursive: true });

function ask(q) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(q, (a) => { rl.close(); resolve(a); });
  });
}

(async () => {
  const pw = process.env.PASSWORD || (await ask("パスワード（8文字以上）: "));
  if (pw.length < 8) { console.error("パスワードは8文字以上にしてください。"); process.exit(1); }
  const db = openDb(dbFile);
  if (db.prepare("SELECT 1 FROM users WHERE email = ?").get(email)) {
    console.error("そのメールアドレスはすでに登録されています。");
    process.exit(1);
  }
  if (empNo && db.prepare("SELECT 1 FROM users WHERE emp_no = ?").get(empNo)) {
    console.error("その社員番号はすでに登録されています。");
    process.exit(1);
  }
  // 一般社員は仮パスワードとして作成し、初回ログイン時に変更してもらう
  db.prepare("INSERT INTO users (email, emp_no, name, pw_hash, role, must_change_pw) VALUES (?, ?, ?, ?, ?, ?)")
    .run(email, empNo, name, hashPassword(pw), role, role === "admin" ? 0 : 1);
  console.log("作成しました: " + email + " " + name + "（" + (role === "admin" ? "管理者" : "一般、初回ログイン時にパスワード変更") + "）");
})();
