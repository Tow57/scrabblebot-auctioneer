// Official CLI nonce flow: convert a one-time team nonce into a saved bot
// credential without displaying the nonce or the resulting JWT.
import { writeFileSync } from 'node:fs';
import { DbConnection, tables } from '../src/module_bindings/index.js';

const alias = process.env.BOT_NAME ?? 'auctioneer';
const code = process.env.BOT_NONCE?.trim();
if (!/^[A-Za-z0-9_-]{1,40}$/.test(alias) || !code) {
  throw new Error('Set a valid BOT_NAME alias and a private BOT_NONCE from the team owner CLI.');
}

await new Promise<void>((resolve, reject) => {
  let connection: DbConnection | undefined;
  let pendingToken = '';
  let acknowledged = false;
  let finished = false;
  const timeout = setTimeout(() => finish(new Error('Credential setup timed out. Mint a new nonce and retry.')), 20_000);
  function finish(error?: Error) {
    if (finished) return;
    finished = true;
    clearTimeout(timeout);
    try { connection?.disconnect(); } catch { /* connection may be closed */ }
    if (error) reject(error); else resolve();
  }
  connection = DbConnection.builder()
    .withUri(process.env.STDB_HOST ?? 'https://maincloud.spacetimedb.com')
    .withDatabaseName(process.env.STDB_DB ?? 'scrabblebot')
    .onConnect((conn, identity, token) => {
      pendingToken = token;
      const verify = () => {
        if (!acknowledged || finished) return;
        const credential = conn.db.botCredential.identity.find(identity);
        if (!credential) return;
        try {
          writeFileSync(`.token-${alias}`, pendingToken, {mode: 0o600, flag: 'wx'});
          console.log(`Bot credential saved locally for bot ID ${credential.botId}. Token was not displayed.`);
          finish();
        } catch { finish(new Error('Cannot save credential: token file may already exist. Use a new local alias.')); }
      };
      conn.db.botCredential.onInsert(verify);
      conn.subscriptionBuilder().onApplied(() => {
        conn.reducers.claimCredential({code}).then(() => {acknowledged = true; verify();})
          .catch(() => finish(new Error('Credential nonce was refused. Mint a fresh nonce from the team owner account.')));
      }).onError(() => finish(new Error('Credential subscription failed.'))).subscribe([tables.botCredential]);
    })
    .onConnectError(() => finish(new Error('Could not connect for credential setup.')))
    .build();
});
