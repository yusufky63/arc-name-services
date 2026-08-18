# Arc name-service operasyon runbook'u

Bu runbook canonical tek EOA Arc Testnet release'i için fail-closed operasyon sırasıdır.
Önceki Safe-owned suite retired ve superseded'dır. Checked-in canonical manifest hâlâ V1'dir:
`active + productLive:false`, controller ve marketplace unpaused, issuer manifestte active'dir.
Bu durum operational-public baseline'dır; funded E2E/operations/recovery kanıtları eksikken
formal product-live iddiası değildir. Aşağıdaki V2 aktivasyon sırası henüz tamamlanmış tarihçe
değil, uygulanacak kontrollü kesim prosedürüdür.

Canonical public UI, OpenAPI, hosted MCP ve funded acceptance tek adımda
`POST /api/registration/prepare` kullanır; wallet `personal_sign` challenge'ı istemez.
`/api/registration/challenge` HMAC/expiry/`personal_sign` kontrolleri yalnız geriye
uyumluluk içindir ve `REGISTRATION_CHALLENGE_SECRET` canonical readiness'e dahil değildir.

## Değişmez incident ilkeleri

1. Önce yeni permit issuance ve yeni marketplace execution'ını durdur; cancel, claim,
   receipt/proceeds reconciliation yollarını açık bırak.
2. Arc RPC receipt ve doğrudan contract state'i truth'tur. BENS, Graph Node, UI cache veya
   explorer kartı ownership kararı veremez.
3. Bir transaction için `status == 1`, beklenen event ve final state birlikte doğrulanır.
4. Raw label, compatibility-only wallet challenge/signature, reusable payment authorization,
   `REGISTRATION_CHALLENGE_SECRET` veya permit signer private key'i ticket/log/evidence
   içine konmaz.
5. Bilinmeyen on-chain sonuç varsayımla success/failure sayılmaz; receipt, `usedPermit`,
   nonce, owner ve pinned-block state reconciliation bekler.
6. Pause/unpause, EOA/owner/treasury/signer veya BENS değişikliği tx hash, block,
   önce/sonra snapshot ve rollback sonucuyla immutable evidence'e girer.

## Mevcut authority ve kritik hedefler

- Chain: Arc Testnet `5042002`
- Checked-in canonical V1 release:
  `0x66aeb7b208fdfb6eb9f728a3d0b12d6d3b7132eb0e363b38f7c388c358edefdc`
- Deployer / protocol owner / treasury / permit signer:
  `0x78de409a6306550882328E2a67160471368387FF`
- Registry: `0xdD69B92f6fAE6da3825b7d126Fe058e78E7F8482`
- Base registrar: `0x0DF136b94f99CAfcC010723b51f8D8EC10A0B907`
- Controller: `0xFbA7618c929075728b82c69B0B2A8C8d98e4B6A3` (unpaused in the canonical manifest)
- Public resolver: `0x3Ea097FFc2089a5Ae24DF46F18d621D007577f5C`
- Reverse registrar: `0x5ecE3F5815813668307BdCe1405B5C765E526837`
- Universal resolver: `0x3FAD66f9F3Ca165118D5b292Fa6036e273718Bf0`
- Marketplace: `0xD63f77a01De40b3964051bA03F4158cceFf1ca46` (unpaused in the canonical manifest)
- Planned V2 addresses: kesim sonrası Foundry receipt + prepared evidence ile üretilmeden
  bu runbook'ta veya UI'da live kabul edilmez.
- Retired release/Safe: `0xcb3130…56bf6` /
  `0xF7c92493f58bBddb1Eb7B8f67AA55e5789a4FB68`; incident target değildir.

Adresler incident anında manifestten ve doğrudan RPC'den yeniden okunur. Bu liste source
verification veya live iddiası değildir.

## Kesim öncesi baseline ve final promotion preflight'ı

V1 pause, V2 deploy veya yeni unpause transaction'ı hazırlanmadan önce çalıştırılacak komut:

```bash
pnpm preflight:release
```

Baseline preflight canonical `.network` RPC'yi, `.vercelignore` sınırını, exact
`pnpm packages:build && pnpm --filter @contour/web build` Vercel profilini, bilinen local secret
değerlerinin source izolasyonunu kontrol eder. Final `productLive:true` manifest, funded ve
operations artefaktları, reviewer bağları ve exact CI/Vercel commit provenance hazır olmadan
`pnpm preflight:release:strict` çalıştırılmaz; strict mod bunları gerektirdiği için pre-unpause
gate'i olamaz. Strict komut yalnız son formal promotion/build adımında çalıştırılır. Exact
commit SHA ve lockfile hash'i operasyon evidence'ine ayrıca yazılır.

Aşağıdaki release gate'lerinden biri eksikse formal promotion hazırlanmaz:

- tamamlanmış 7/7 ArcScan source/ABI snapshot'ının verifier-compatible immutable public
  URL + checksum publication'ı, verified block ve promotion verifier PASS;
- bağımsız role-keyed runtime hash trust root'ları;
- registrar/controller/marketplace owner, controller/marketplace treasury ve permit
  signer'ın exact canonical funded EOA ile parity'si; boş `pendingOwner`;
- registry root/reverse-root authority parity ve registrar controller-history replay;
- canonical direct `/api/registration/prepare` request/origin/chain/release/profile/requester/
  intent binding'i ve fresh nonce/availability/quote kontrolleri; bu yol `personal_sign` veya
  challenge secret kullanmaz;
- compatibility-only `/api/registration/challenge` sunuluyorsa canonical 21-line message
  HMAC proof'u, 120s expiry, deterministic permit ID ve tamper/replay/origin/release/wallet
  recovery testleri; secret yoksa compatibility route fail-closed kalır ve canonical
  readiness etkilenmez;
- aynı funded EOA server secret injection'ı, local signature recovery ve EOA
  compromise/pause/rotation/clean-redeploy drill'i;
- issuer body/time/concurrency caps, Vercel Firewall/edge rate policy ve readiness parity;
- wallet harness/account/USDC bütçesi, browser matrix planı, simulations ve
  shared-USDC fixtures; gerçek funded registration/market smoke kontrollü unpause
  penceresinde çalıştırılır;
- bu runbook'un operator drill'i ve receipt/state evidence kontrolleri;
- immutable evidence index ve bağımsız reviewer onayı.

Detaylı gate listesi
[`docs/ACCEPTANCE_MATRIX.md`](ACCEPTANCE_MATRIX.md), publication politikası
[`docs/EVIDENCE_POLICY.md`](EVIDENCE_POLICY.md)'dir.

## Kontrollü V2 aktivasyon sırası

Bu bölüm V2 production geçişinin güncel fail-closed operasyon sırasıdır. Geçici private
candidate bütün ingress'te Basic Auth kullanır; final canonical public deployment'ta site
password'u veya candidate credential'ı bulunmaz.

1. `pnpm preflight:release` çalıştırılır. V1 name/owner/expiry, açık listing,
   liability/balance, yedi runtime identity ve owner/wiring state'i kesim öncesi pinned
   block'ta reconcile edilir.
2. Yalnız V1 controller registration için dry-run incelenir, sonra pause transaction'ı
   gönderilir. Exact success receipt, sender/target/calldata/value, block ve block hash
   doğrulanmadan kesim tamamlandı sayılmaz.
3. Aynı confirmed block'ta create-new retained manifest ve ekonomik snapshot üretilir:

   ```bash
   pnpm prepare:v1-cutover-manifest \
     --manifest deployments/5042002.legacy.json \
     --pause-transaction <v1-pause-transaction-hash> \
     --cutover-block <confirmed-cutover-block> \
     --cutover-block-hash <confirmed-cutover-block-hash> \
     --output deployments/local/5042002-v1-cutover.json
   pnpm capture:v1-economic-cutover \
     --manifest deployments/local/5042002-v1-cutover.json \
     --cutover-block <confirmed-cutover-block> \
     --output deployments/local/5042002-v1-economic-cutover.json
   ```

   Bu araçlar canonical dosyayı değiştirmez ve mevcut output'u overwrite etmez. V1 market
   `paused:false`, runtime/release/owner/wiring ve inventory/liability parity PASS olmadan
   `registrationsPaused:true` retained policy'si yayımlanmaz.
4. V2 draft yalnız bu paused V1 manifestinden oluşturulur. V2 yedi-kontrat suite'i canonical
   metadata base URI ile deploy edilir; controller ve marketplace paused kalır. Receipt-bound
   configured manifest hazırlanır, 7/7 source/ABI ve runtime/wiring doğrulanır; chain capture
   explicit V2 dosyasını kullanır:

   ```bash
   node scripts/create-fresh-deployment-template.mjs \
     deployments/local/5042002-v1-cutover.json \
     deployments/local/5042002-v2-draft.json \
     --registrar-version v2
   pnpm capture:configured-state \
     --manifest deployments/local/5042002-v2-prepared/manifest.configured.json \
     --output deployments/local/5042002-v2-configured-chain-state.json
   ```

5. V2 configured evidence immutable/hash-pinned olarak public canonical
   V1/evidence-only deployment'ta yayımlanır. Bu sırada V1 registration intentionally
   paused, V1 marketplace ve mevcut read/renew/transfer/exit yolları açık, V2 execution
   kapalıdır. Candidate hostta `/evidence/**` dahil hiçbir Basic Auth bypass'ı açılmaz.
6. Permit signer secret'ı Vercel server runtime'ına enjekte edilir; key identity, local
   EIP-712 recovery, pause/rotation/redeploy ve secret-leak kontrolleri issuance olmadan
   doğrulanır. Compatibility challenge route'u sunulacaksa ayrı secret ve yalnız o route'un
   HMAC/expiry/recovery kontrolleri doğrulanır.
7. Exact retained reference taşıyan
   `active + productLive:false + permitIssuer.active:true` manifest public alias'a geçmeden
   hazırlanır. Issuer ve web aynı staged digest ile `PRIVATE_CANDIDATE_MODE=true` kullanarak
   production target'a `--skip-domain` ile deploy edilir. `/`, statik asset, `/status`, API
   ve `/evidence/**` dahil bütün anonymous istekler `401 + Basic challenge + no-store`
   almalıdır. V2 controller paused olduğundan authenticated readiness `503` olmalı ve permit
   üretilmemelidir.
8. Tek owner EOA V2 controller-open calldata/value/policy digest'ini inceler ve transaction'ı
   gönderir. Receipt + V1-paused/V2-open state parity ve issuer readiness `200` hemen
   doğrulanır. Başarısızsa önce V2 tekrar pause edilir; V1 yalnız V2 pause receipt/state
   doğrulamasından sonra rollback kapsamında açılabilir.
9. Private direct-registration smoke önce read-only, sonra explicit release ID + registrant
   teyitli broadcast olarak çalıştırılır. Schema `1.0.0`
   `registrationActivationSmoke/PASS` ve marketplace pause parity'si olmadan V2 marketplace
   açılmaz.
10. V2 marketplace ayrı owner transaction'ıyla açılır; listing/buy/cancel/claim/solvency
    smoke ve pause rollback'i doğrulanır. V1 marketplace açık kalır.
11. Promotion verifier staged candidate manifest + exact candidate origin + live issuer için
    PASS olduktan sonra `active + productLive:false` release ayrı, credential'sız public
    build ile operasyonel Arc Testnet erişimine alınabilir. Bunun için `public` environment
    modu kullanılır; candidate artifact'i promote edilmez:

    ```bash
    pnpm sync:vercel-release-env -- --mode public
    npx vercel@50.28.0 deploy --prod --yes
    ```

    Bu durum dürüstçe **operational-public** olarak adlandırılır; `productLive:true`,
    evidence-complete veya G99 PASS değildir.
12. Fully-open V2 için exact later block'a bağlı, non-publishable
    `promotionTargetIntent` üretilir. Funded run ve operations broadcast aynı
    `--target-intent` dosyasını kullanır.
13. Funded ve operations schema `1.0.0` PASS raporları ile throwaway signer
    activation/rotation/revoke, clean-redeploy ve offline key recovery evidence'i bağımsız
    reviewer incelemesine girer. Son recovery kanıtları bugün yoktur; G90/G99 `BLOCKED`
    kalır ve eksikken signed operations envelope üretilmez.
14. Gerçek envelope URL/hash'leriyle final product-live manifest hazırlanır; target-intent
    digest'leriyle exact eşleşir ve promotion verifier PASS olur. Yalnız şimdi exact
    CI/Vercel commit binding'iyle `pnpm preflight:release:strict` çalıştırılır.
15. Candidate credential'ları production environment'tan kaldırılır; web ve issuer aynı
    exact `PRODUCT_LIVE_RELEASE=<releaseId>:<manifestSha256>:<verifiedAtBlock>` değerine
    bağlanır. Candidate artifact'i promote edilmez; ayrı public-live build/deployment
    canonical alias'a alınır. `PRIVATE_CANDIDATE_MODE=false` dahil hiçbir candidate runtime
    anahtarı bırakılmaz. Anonymous public health ve internal-header spoofing negatifleri
    yeniden doğrulanır.
16. İlk bloklarda tx failure, direct prepare/signer error, concurrent loser oranı,
    owner/treasury/signer/pause parity ve USDC liabilities doğrudan log/RPC/state üzerinden
    izlenir. Her sapmada aşağıdaki geri alma çalışır.

Production-scope Vercel environment ve deployment sırası:

```bash
# Exact V1 pause/cutover ve V2 configured evidence PASS sonrasında,
# V1-paused/evidence-only source state'inde:
pnpm sync:vercel-release-env -- --mode public
npx vercel@50.28.0 deploy --prod --yes

# Gitignored candidate secret dosyası hazırken; canonical alias değişmez:
pnpm sync:vercel-release-env -- --mode private-candidate
npx vercel@50.28.0 deploy --prod --skip-domain --yes

# Operational acceptance PASS ise active + productLive:false V2'yi ayrı public build yap:
pnpm sync:vercel-release-env -- --mode public
npx vercel@50.28.0 deploy --prod --yes

# Exact final manifest/binding ve bütün acceptance kanıtları hazırken:
pnpm sync:vercel-release-env -- --mode public-live --binding <releaseId:manifestSha256:verifiedAtBlock>
npx vercel@50.28.0 deploy --prod --yes
```

Bu dört komut çifti aynı artifact'i temsil etmez. İlk public deploy V1 registration paused
iken yalnız evidence publication sınırıdır. Private candidate üretim environment'ını
gerçekçi sınar fakat `--skip-domain` nedeniyle canonical alias'ı almaz. Üçüncü deploy,
yalnız operational gate'ler PASS ise V2 `active + productLive:false` durumunu candidate
credential'ları olmadan public yapar. Final product-live ise bütün formal gate'ler ve exact
binding hazırlandıktan sonra yeniden build edilir. Candidate URL'sine `vercel promote`
uygulanmaz.

## Operations drill

Target intent önce ve sahte live-only artefakt üretmeden hazırlanır:

```bash
pnpm prepare:promotion-target-intent \
  --manifest <active-market-open-candidate.json> \
  --verified-at-block <later-pinned-block> \
  --output <promotion-target-intent.json>
```

Broadcast root `.env` içindeki normalized canonical EOA key'ini ve
`PROMOTION_CANDIDATE_INGRESS_USERNAME/PASSWORD` değerlerini kullanır. `ARC_RPC_URL` varsa
exact `https://rpc.testnet.arc.network` olmalıdır:

```bash
pnpm drill:operations --broadcast \
  --manifest <active-market-open-candidate.json> \
  --target-intent <promotion-target-intent.json> \
  --confirm-release <exact-release-id> \
  --candidate-url <https://private-candidate-host> \
  --output <new-operations-pass.json>
```

Bu invocation dört canonical pause/unpause receipt'ini, readiness close/recovery
assertion'larını ve evidence block'u exact promotion target'a bağlayan no-overwrite rapora
yazar. Çıktı `schemaVersion: "1.0.0"`, `artifact: "operationsDrill"`,
`verdict: "PASS"`'dir. Hata sonrasında fail-safe repause sonucu incelenmeden aynı run
tekrarlanmaz.

Bu PASS raporu canonical pause/readiness kapsamıdır. 24 saatlik signer activation/
rotation/revoke, clean-redeploy ve offline-recovery kanıtları ayrıca tamamlanıp aynı release
review'una bağlanmadıkça operasyon gate'i PASS değildir.

## Aktivasyon geri alma

1. Issuer'da yeni direct permit üretimini; compatibility route açıksa yeni challenge/permit
   üretimini de kapat.
2. Tek owner EOA ile controller registration'ı pause et; receipt + state doğrula.
3. Aynı owner EOA ile marketplace execution'ını pause et; cancel/claim yollarının açık kaldığını
   doğrula.
4. Public web executable aksiyonlarını kapat, manifest/read yüzeyini read-only tut.
5. Son issuance penceresindeki Arc receipt + `usedPermit` + nonce + owner state'ini
   reconcile et; timeout yüzünden sonucu varsayma.
6. Seller/referral liability ve proceeds'i değiştirmeden önce direct balances/state
   snapshot'ı al. Ambiguous ödeme/tx'yi manual review'a taşı.
7. Incident evidence'i, cause ve reopen gate'ini yayınla. Eski başarılı registration veya
   NFT ownership'ini geri almaya çalışma.

## Yarım deployment recovery

- Canonical manifest yalnız yedi direct creation'ın address/tx/positive block set'i tam
  olduğunda `configured` olur. Yarım suite bu dosyaya yazılmaz.
- Broadcast yarıda kalırsa funded deployer adresi, chain ID, nonce ve her success receipt
  Foundry broadcast ile RPC üzerinde karşılaştırılır. Aynı script/config byte'larıyla
  güvenli `--resume` kanıtlanabiliyorsa yalnız eksik nonce'lardan devam edilir.
- Constructor/config/release ID farklıysa veya bir nonce sonucu belirsizse resume edilmez;
  yeni release ID ile temiz deployment yapılır. Eski adresler yeni suite'e karıştırılmaz.
- Ownership transfer başlatılmış fakat accept edilmemişse `pendingOwner`, current owner ve
  owner EOA calldata'sı doğrudan RPC'den doğrulanır. Acceptance transaction'ı tekrar
  oluşturulmadan önce önceki tx receipt'i aranır.
- Owner/treasury/signer parity kontrollerinden biri eksikse controller/market pause kalır.
- Evidence dosyaları overwrite edilmez; her attempt ayrı checksum/index entry taşır.

## Permit signer

`ArcPermitSignerFailures` kritik alarmında issuance fail-closed tutulur. Vercel secret
revision/deployment erişimi, derived signer adresi, canonical/on-chain signer parity ve
local EIP-712 recovery sonucu kontrol edilir. Canonical funded EOA dışında fallback yasaktır.

Compromise şüphesinde önce issuance durdurulur. EOA hâlâ güvenilir biçimde kontrol
edilebiliyorsa controller/marketplace pause edilir ve owner/treasury/signer yeni EOA'ya
rotate edilir. Güvenilir kontrol yoksa mevcut suite reopen edilmez; yeni EOA ve release ID
ile clean redeploy yapılır. Eski outstanding permit'ler deadline/used state'e göre
reconcile edilmeden yeni release açılmaz.

## Direct prepare, compatibility challenge ve permit yarışları

Canonical public UI, OpenAPI, hosted MCP ve funded acceptance doğrudan
`/api/registration/prepare` çağırır. Bu yol wallet `personal_sign` veya challenge HMAC'i
istemez; exact request ID/origin/chain/controller/release/profile/requester/intent
fingerprint'ini fresh quote, nonce, availability ve allowance state'iyle bağlar. Direct
permit ID `contour-registration-direct-permit-id/v1` domain'inde request ID, issuance zamanı,
fingerprint, requester ve current controller nonce'undan deterministik türetilir.

Aşağıdaki HMAC ve wallet recovery kontrolleri yalnız compatibility-only
`/api/registration/challenge` akışı içindir. Yalnız secret-redacted request/permit ID ve
hashed fingerprint aggregate'lerini incele. Compatibility challenge proof şu exact preimage
ile HMAC-SHA256 olmalıdır:

```text
contour-registration-challenge/v1\n<challengeId>\n<canonical-21-line-message>
```

Compatibility permit ID aynı server secret ile domain-separated
`contour-registration-permit-id/v1`, challenge ID, exact request fingerprint, requester ve
current controller nonce'undan deterministik türetilir. Secret veya raw preimage loglanmaz.
Compatibility challenge tam 120 saniye geçerlidir; bu yoldaki permit `issuedAt` değerini
challenge'dan alır ve default 180 saniyedir.

Stateless issuer exclusive reservation tutmaz. Aynı label için eşzamanlı permit görmek tek
başına incident değildir. Beklenen invariant: en fazla bir Arc transaction'ı success olur;
kaybeden transaction `NameUnavailable`/nonce guard ile ödeme ve state bırakmadan revert
eder. Birden fazla successful registration, double payment, wrong recipient/payer veya
revert sonrası consumed permit görülürse issuance stop, controller pause ve signer revoke
değerlendirmesi yapılır.

## Response loss ve receipt recovery

Server'da submitted/manual-review tablosu yoktur. UI veya operator belirsiz sonucu
transaction hash varsa receipt; yoksa requester nonce, `usedPermit`, registrar owner/
availability ve registry state'iyle pinned block'ta karşılaştırır. On-chain success varsa
yeni permit istenmez; failure veya expiry ancak chain evidence ile belirlenir.

## Issuer readiness

Readiness false ise wallet/payment akışı başlamamalıdır. Probe chain ID, controller,
release, normalization profile, signer, policy version, pause state, RPC, exact
`PRODUCT_LIVE_RELEASE` ve locally derived signer parity'sini aynı snapshot'ta kontrol eder.
Canonical probe `REGISTRATION_CHALLENGE_SECRET` varlığını kontrol etmez; secret'ın yokluğu
yalnız compatibility challenge route'unu fail-closed yapar. Probe public browser trust root'u
değildir. Cache/stale sonuçla gerçeği varsayma; direct on-chain state ve fresh local EIP-712
signature recovery'yi doğrula.

## Tek EOA ve on-chain policy drift

Controller/market owner, treasury, signer, registry authority, `pendingOwner`, referral/fee
bps veya pause state manifest/evidence'dan saparsa issuance ve public actions kapanır.
Canonical tek EOA dışında herhangi bir authority görülürse promotion attestation geçersiz
sayılır ve yeni snapshot/review gerekir.

## RPC veya Arc explorer

Explorer unavailable olması chain failure değildir. Bu release'in tek operational HTTP RPC'si
`https://rpc.testnet.arc.network` adresidir; WebSocket transportu kapalıdır ve başka host
fallback olarak kullanılmaz. Operator chain ID, pinned head/block, receipt ve aynı block'taki
code/state'i bu canonical endpoint'ten yeniden okur. Normal HTTP profili process başına
2.100 ms aralık ve yalnız `-32011`/HTTP `429` için en fazla üç deneme kullanır. Uzun,
salt-okunur promotion audit'i 6.000 ms aralık, en fazla altı rate-limit denemesi ve
18.000 ms cap'li backoff ile daha konservatiftir. Uygun read'ler 25 ms Multicall
penceresinde birleştirilir. Bu, bağımsız ikinci-provider consensus kanıtı
değildir. Endpoint sonucu stale, wrong-chain, rate-limit sonrasında belirsiz veya receipt/state
ile çelişkiliyse yeni transaction yoktur ve manual review gerekir. Arc'ın hızlı finality'si
`status==1` dışındaki event/state doğrulamasını kaldırmaz.

## Marketplace ve treasury

Yeni buy/listing execution'ını pause et; cancel ve claim'i kapatma. Direct contract
balance, seller proceeds liability ve withdrawable surplus'u aynı block'ta karşılaştır.
Native ve ERC-20 USDC tek underlying balance olduğundan “beklenmeyen native” adıyla tam
balance sweep yapılmaz. Solvency belirsizse treasury withdrawal hazırlanmaz.

## x402 stuck

Release 1'de x402 disabled ve process listener mount etmemelidir. Bu alarmların aktif
release'te trafik görmesi config/security incident'tır: keeper'ı kapat, credentials'ı
revoke et ve hiçbir payment authorization'ı registration success sayma. Gelecek gated
release'te durable order state'ten devam etmeden önce transaction receipt doğrulanır.

## x402 refund

Order/payment ID'lerini immutable tut. Refund öncesi Gateway settlement'ın gerçekleşip
gerçekleşmediğini bağımsız kontrol et; response loss sonrası çift ödeme yapma. Ambiguous
settlement manual review'a gider. Reusable authorization evidence'e eklenmez.

## x402 manual review

State'i zorla ilerletme. Receipt, permit, payment ve facilitator sonuçlarını order ID
altında bağla; secret/authorization materialini ticket dışında tut. Registration ve
settlement kanıtları birbirinin yerine geçmez.

## BENS

BENS health kaybında core dApp direct RPC'de kalır, search badge/claim kapatılır. Core
issuer'ın stateless olması BENS'i değiştirmez: self-hosted BENS/Graph Node kendi ayrı
PostgreSQL'i ve operatörüyle çalışır. Bu PostgreSQL, BENS, Graph Node ve ingress health'i;
pinned image digest/config; domain,
address, lookup ve batch endpoint'leri kontrol edilir. Bir isim için registry/registrar/
resolver direct state'i aynı block'taki BENS sonucuyla karşılaştırılır. Restore/migration
rollback drill'i geçmeden `protocolConfigured` veya healthy iddiası yapılmaz.

Hosted ArcScan bizim authority'miz değildir. Self-hosted health, ArcScan search'ün aktif
olduğunu kanıtlamaz; operator confirmation ve canlı name↔address fixture yoksa
`hostedArcscanActive:false` kalır.

## Subgraph

Explorer visibility promotion'ını durdur. Fatal indexing errors, chain head/lag, IPFS ve
PostgreSQL health'i ile her data source'un configured positive start block'unu kontrol et;
block `0` kullanma. Reorg/restore sonrası exact deployment block'tan deterministic replay,
mapping build hash ve pinned-block direct RPC parity yapılır. Expired veya forward-
unconfirmed reverse isim verified primary gösterilmez.

## Incident kapanışı ve evidence

Kapanış kaydı başlangıç/bitiş zamanını, chain/release, first/last observed block'u,
etkilenen capability'yi, pause/revoke tx'lerini, secret-redacted log/evidence checksum'larını,
root cause'u, recovery testlerini ve reviewer'ı içerir. Reopen yalnız ilgili acceptance
gate tekrar PASS ve promotion binding güncel olduğunda yapılır. Public-live operasyon
drill özeti bağımsız reviewer-signed envelope; detaylı rapor ise immutable hash-pinned
ek olmalıdır.
