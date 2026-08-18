# Deployment ve aktivasyon rehberi

> **Checked-in state (24 July 2026):** the canonical manifest is still the V1
> release, `active + productLive:false`, with registration and marketplace open.
> V2 source, deployment tooling and metadata support are prepared, but this
> repository does not yet contain a confirmed V2 deployment or a V1 pause
> receipt. Do not describe V2 as live until the cutover sequence below has
> produced and verified those exact artifacts.

Bu belge, Contour Name Protocol'ün yerel geliştirmeden public-live aktivasyona kadar
izlenecek fail-closed yolunu tanımlar. Güncel V1 adresleri ve capability durumu için
[`deployments/5042002.json`](../deployments/5042002.json), kesim öncesi V1 kopyası için
[`deployments/5042002.legacy.json`](../deployments/5042002.legacy.json), kabul kapıları için
[`ACCEPTANCE_MATRIX.md`](ACCEPTANCE_MATRIX.md), incident ve rollback adımları için
[`OPERATIONS_RUNBOOK.md`](OPERATIONS_RUNBOOK.md)'dir.

## 1. Mevcut durum

| Katman | Durum | Açıklama |
| --- | --- | --- |
| Canonical checked-in release | V1 `active / operational-public` | `activationEvidence.productLive:false`; registration ve marketplace açık |
| Planned V2 | `not cut over` | Source/tooling hazır; confirmed deploy receipt, canonical V2 manifest ve V1 pause receipt henüz yok |
| Future retained V1 | `not cut over` | Kesimden sonra mevcut token, renew/transfer/resolver ve V1 marketplace original contracts üzerinde kalır |
| V1 registration | `open` | Yalnız exact pause receipt ve cutover-block doğrulamasından sonra retained policy `registrationsPaused:true` olabilir |
| Authority | On-chain configured | `0x78de409a6306550882328E2a67160471368387FF` deployer/owner/treasury/permit signer; Safe yok |
| Web | Public operational baseline | `https://contour-arc.vercel.app`; no password gate; bu tek başına formal product-live kanıtı değildir |
| Permit issuer | Manifestte active | Runtime health/readiness kesim penceresinde yeniden doğrulanır |
| Registration | Open on V1 | V2 unpause yapılana kadar execution V1'e aittir |
| Marketplace | Open on V1 | V2 market ancak V2 registration smoke PASS sonrasında ayrı işlemle açılır |
| Metadata | Companion routes implemented; V2 native pending | V1 için release-aware JSON/SVG application routes; V2 `tokenURI` yalnız V2 aktivasyonundan sonra |
| Evidence | Core published; product-live incomplete | Funded E2E, operations drill ve independent reviewer/recovery kanıtları tamamlanmadan `productLive:true` kullanılamaz |
| BENS | Kapalı | Graph Node replay/sync/parity ve public BENS endpoint yok |
| Hosted ArcScan names | Kapalı | Haricî operator aktivasyon kanıtı yok |
| x402 / EIP-3009 | Release 1'de kapalı | Ayrı gelecek release ve funded security review gerekir |

Checked-in `5042002.legacy.json` henüz immutable kesim snapshot'ı değildir; açık V1'in
kesim öncesi kopyasıdır. `registrationsPaused:true` değeri elle yazılmaz. Exact V1 pause
receipt'i ve block hash'i `pnpm prepare:v1-cutover-manifest` tarafından RPC'de doğrulanıp
yeni bir dosyaya yazıldıktan sonra bu çıktı retained snapshot ve V2 `legacyReleases[]`
trust root'u olabilir. Full reference ile V2 policy exact eşleşmezse web, SDK ve MCP
dual-release işlemlerini fail-closed durdurur.

## 2. Yerel çalışma ve doğrulama

Gereksinimler:

- Node.js `>=22.13 <25` for repository tooling (`contour-sdk` remains `>=20.9 <25`);
- repository'de `packageManager` alanıyla pinlenen pnpm;
- contract testleri için Foundry;
- yalnız canonical Arc Testnet HTTP RPC'sine salt-okunur erişim:
  `https://rpc.testnet.arc.network`.

Canonical manifestteki tek RPC endpoint'i
`https://rpc.testnet.arc.network`'tür. WebSocket transportu kapalıdır ve bu release başka
bir operational fallback host kullanmaz. Web ve operator HTTP transport'larının normal profili
process başına istekleri 2.100 ms aralıkla sıraya koyar; yalnız JSON-RPC `-32011` veya HTTP
`429` rate-limit sinyalinde en fazla üç deneme yapar ve alttaki Viem retry'sini kapatır.
Uzun, salt-okunur `verify:promotion` audit'i 6.000 ms aralık, en fazla altı rate-limit
denemesi ve 18.000 ms cap'li backoff kullanan konservatif istisnadır. Uygun read grupları
25 ms Multicall penceresinde birleştirilir. Web readiness yalnız aynı anda gelen aynı read'i
coalesce eder; tamamlanmış sonuç cache'lenmez. Bunlar global Vercel rate limit veya bağımsız
ikinci RPC gözlemi değildir; edge/WAF ve pinned-block receipt/state doğrulaması yine gereklidir.

```bash
pnpm install --frozen-lockfile
pnpm dev
pnpm verify
```

Web varsayılan olarak `http://localhost:3002` adresindedir. Checked-in canonical active
manifest ile beklenen kontroller:

- `/api/manifest` HTTP `200`, `state: active`, `productLive: false`;
- `/api/registration/readiness`, server signer key'i canonical/on-chain policy ile eşleşiyorsa
  HTTP `200`; signer eksik veya parity bozuksa fail-closed HTTP `503`;
- registration/marketplace yüzeyleri yalnız active manifest, unpaused policy ve readiness
  koşullarıyla executable;
- sayfa genişliği bütün rotalarda `max-w-7xl` sınırı içinde;
- browser console error ve yatay taşma yok.

Root `pnpm dev` launcher'ı yalnız `NODE_ENV=development` ve loopback isteklerinde
`REGISTRATION_ALLOW_LOOPBACK_CANONICAL_ORIGIN=true` değerini child process'e verir. Böylece
yerel UI, imzaya localhost yazmak yerine checked-in manifestte sabitlenmiş issuer origin'ini
kullanır. Bu köprü production runtime'da etkinleşemez; doğrudan web workspace dev komutu da
bu opt-in'i almaz.

`pnpm verify`, TypeScript/lint/build testlerine ek olarak config, normalization, SDK,
issuer, x402, MCP, BENS ve Foundry testlerini çalıştırır. Bu komutun geçmesi public
deployment, server signer readiness veya funded acceptance kanıtının yerine geçmez.

## 3. Secret ve environment sınırı

Root `.env`, `.env.deployment.local`, `apps/web/.env.local` ve `.local-keystores/`
public deployment paketine, git'e, browser bundle'a veya evidence dosyasına eklenmez.
Bu Arc Testnet-only profil aynı funded EOA key'ini deployer, owner, treasury ve permit
signer olarak kullanır. Deploy/admin key dosyası yalnız yerel operator secret'ında tutulur.
Permit imzalama için gereken aynı key değeri deployment platformunun server secret
store'undadır; public issuer/readiness `200` sonucu derived signer'ın canonical ve on-chain
signer ile eşleştiğini kanıtlar. Ayrı rastgele challenge HMAC değeri yalnız geriye uyumlu
`/api/registration/challenge` akışı içindir; canonical UI/OpenAPI/hosted MCP ve acceptance
akışı doğrudan `/api/registration/prepare` kullanır.
Kök [`.vercelignore`](../.vercelignore) bu sınırı upload sırasında ayrıca zorlar;
`.env.production` dâhil environment dosyaları upload edilmez.

Safe owner keystore'u, ikinci/üçüncü owner parolası veya threshold imzası gerekmez. Root
`.env` içindeki funded EOA private key'i deployment/admin kaynağıdır; aynı exact key'in
server-runtime kopyası `REGISTRATION_PERMIT_SIGNER_PRIVATE_KEY` olarak secret yönetimi
üzerinden sağlanır. Public readiness bu signer parity'sini doğrular. Değer Vercel upload
dosyalarına, build loguna veya client bundle'a girmez.

Root package script'leri `pnpm dev`, `pnpm fund:e2e-buyer`, `pnpm admin:activation`,
`pnpm acceptance:funded`, `pnpm drill:operations` ve `pnpm sign:promotion-pass` için `.env`
dosyasını otomatik yükler; operatorün ayrıca shell'e key export etmesi gerekmez. İzole release
aktivasyon materyali kullanan komutlar ayrıca gitignored
`.local-keystores/release-activation.env` dosyasını yükler. Bu komutlardaki
`PRIVATE_KEY`/`ADMIN_PRIVATE_KEY`/`E2E_BUYER_PRIVATE_KEY`/`PROMOTION_REVIEWER_PRIVATE_KEY`
değerleri hem 64 hex karakter hem `0x` + 64 hex biçiminde kabul edilir, bellekte canonical
`0x` biçimine çevrilir ve hiçbir çıktıya yazılmaz. Buyer governance/seller hesabından,
reviewer ise governance hesabından farklı olmalıdır. Vercel production signer secret'ı yine
Sensitive server alanında canonical `0x` biçiminde saklanır; root `.env` upload edilmez.

Deploy öncesi `pnpm provision:deployer-keystore`, `PRIVATE_KEY`'in
`DEPLOYER_ADDRESS` ile eşleştiğini doğrulayıp gitignored scrypt/AES Web3 keystore ve
ayrı random password dosyası üretir; mevcut dosyanın üzerine yazmaz. Forge deploy
`--keystore .local-keystores/contour-v2-deployer --password-file .local-keystores/contour-v2-deployer.password`
kullanır. Raw private key hiçbir zaman CLI argümanına yazılmaz.

Public non-live V1/evidence-only baseline için temel alanlar:

```dotenv
NEXT_PUBLIC_SITE_URL=https://<public-host>
PRODUCT_LIVE_RELEASE=false
# PRIVATE_CANDIDATE_MODE ve iki ingress credential'ı tanımlanmaz.
```

Final public-live build'de ise:

```dotenv
NEXT_PUBLIC_SITE_URL=https://<public-host>
PRODUCT_LIVE_RELEASE=<releaseId:manifestSha256:verifiedAtBlock>
# PRIVATE_CANDIDATE_MODE ve iki ingress credential'ı tanımlanmaz.
```

Private-candidate ingress V2 rollout'unun etkin, geçici acceptance sınırıdır. Runtime
credential'ları gitignored `.local-keystores/release-activation.env` dosyasından okunur:

```dotenv
PRIVATE_CANDIDATE_INGRESS_USERNAME=<candidate-basic-auth-user>
PRIVATE_CANDIDATE_INGRESS_PASSWORD=<at-least-32-character-candidate-password>
```

Operator-side promotion CLI, browser build'lerine veya public-live deploy'a taşınmayan
ayrı trusted shell/CI secret scope'unda şu gerçek adları kullanır:

```dotenv
PROMOTION_CANDIDATE_INGRESS_USERNAME=<same-candidate-basic-auth-user>
PROMOTION_CANDIDATE_INGRESS_PASSWORD=<same-candidate-basic-auth-password>
PROMOTION_AUTHENTICATED_CANDIDATE_SOURCE=false
PROMOTION_ALLOWED_FETCH_HOSTS=<canonical-evidence-hosts>,<unaliased-candidate-hostname>
```

Bu iki operator credential alanı yalnız `pnpm verify:promotion` çalıştıran trusted shell/CI
scope'unda birlikte tanımlanır. Manifestteki `permitIssuer.url` canonical public URL olarak
kalır. Operator her private doğrulamada path/query/fragment/credential içermeyen exact
`https://<unaliased-candidate-host>` değerini `--candidate-origin` ile ayrıca verir; hostname
`PROMOTION_ALLOWED_FETCH_HOSTS` içinde de bulunmalıdır. Verifier canonical issuer path'ini
koruyup yalnız origin'i değiştirir. CLI Basic header'ı bellekte üretir, yalnız origin'i bu
exact aday origin'iyle eşleşen `healthz` isteğine ekler, redirect'i reddeder ve credential'ı
loglamaz. Eksik origin, farklı origin veya origin yerine path içeren URL fail-closed reddedilir. Candidate auth;
Arc RPC, ArcScan, ABI veya evidence URL'lerine gönderilmez. Normal product-live
doğrulaması candidate credential'larını reddeder. Tek istisna explicit target-promotion
prosedürüdür: operator `PROMOTION_AUTHENTICATED_CANDIDATE_SOURCE=true` ile iki credential'ı
birlikte sağlar; işlem bittikten sonra üç alan da kaldırılır.

Private proxy candidate hosttaki **bütün ingress'i** korur: `/`, statik asset'ler,
`/status`, issuer/API yolları ve `/evidence/**` için istisna yoktur. Anonymous veya yanlış
credential'lı istek `401`, `WWW-Authenticate: Basic` ve `Cache-Control: no-store` alır.
Doğru credential'dan sonra proxy `Authorization` ile client-supplied internal header'ları
downstream request'ten siler. Eksik/geçersiz candidate configuration `503` ile fail-closed
kalır.

Bu nedenle V2 manifestinin referans verdiği immutable kanıtlar private candidate hostta
yayımlanmaz ve Basic Auth bypass'ı eklenmez. Kanıtlar candidate kurulmadan önce hâlâ public
olan canonical hosta, V1'i ve execution policy'sini değiştirmeyen review edilmiş güvenli
V1/evidence-only deployment ile yayımlanır; verifier bu public URL'leri redirect olmadan
indirip exact SHA-256 ile doğrular.

Web ile aynı Vercel runtime'ında çalışan canonical direct issuer şu server-only alanları ister;
challenge secret yalnız compatibility route'u ayrıca etkinse gerekir:

```dotenv
ARC_RPC_URL=https://rpc.testnet.arc.network
REGISTRATION_PERMIT_SIGNER_PRIVATE_KEY=0x<64-hex-funded-owner-eoa-key>
REGISTRATION_PERMIT_TTL_SECONDS=180
REGISTRATION_CHALLENGE_ORIGIN=https://<public-host>
PRODUCT_LIVE_RELEASE=false
# Compatibility route only:
REGISTRATION_CHALLENGE_SECRET=<at-least-32-character-server-secret>
```

Signer key ve compatibility challenge secret repository, build log, browser env veya
evidence'te tutulmaz. `REGISTRATION_CHALLENGE_ORIGIN` adı legacy olsa da direct permit'in
canonical public origin bağını da sağlar ve public origin ile exact eşleşir.
`PRODUCT_LIVE_RELEASE` yalnız final atomik rollout'ta
`<releaseId>:<manifestSha256>:<verifiedAtBlock>` exact değeriyle açılır.

## 4. Baseline web deployment

Repository kökündeki [`vercel.json`](../vercel.json) Next.js monorepo build'ini tanımlar:

1. `pnpm install --frozen-lockfile`;
2. `pnpm packages:build` ile workspace paketlerinin temiz build'leri;
3. `pnpm --filter @contour/web build` ile web production build'i;
4. `apps/web/.next` çıktısının yayını.

Production'da doğrulanmış exact
`pnpm packages:build && pnpm --filter @contour/web build` komutu release preflight
tarafından fail-closed kontrol edilir.

Source upload veya deploy'dan önce:

```bash
pnpm preflight:release
```

Bu baseline canonical operational RPC değerlerini, zorunlu `.vercelignore` exclusions'larını,
exact Vercel build command/output dizinini ve `.env`/`apps/web/.env.local` içindeki bilinen
secret değerlerinin seçili source ağacında tekrar görünmediğini kontrol eder. Bu, bilinmeyen
bir secret'ı veya Vercel server-side secret store'unu tarayan genel amaçlı DLP değildir.

Yalnız final formal `productLive:true` manifest, funded/operations kanıtları ve
CI/deployment commit binding'i hazırlandıktan sonra:

```bash
pnpm preflight:release:strict
```

Strict mod baseline'a ek olarak canonical manifestin `active + productLive:true` olmasını,
hash-pinned `fundedEndToEnd` ve `operationsDrill` kanıtlarının ikisinin de bulunmasını, temiz
worktree'yi ve çözümlenebilir bir Git HEAD'i zorunlu tutar. Ayrıca aktif GitHub Actions
bağlamındaki `GITHUB_SHA` veya Vercel deployment bağlamındaki `VERCEL_GIT_COMMIT_SHA` exact
HEAD ile eşleşmelidir; bağın eksik, geçersiz veya farklı olması promotion'ı fail-closed
durdurur. Bu nedenle strict komut V1 pause veya V2 unpause ön koşulu değildir; kesim
hazırlığında `pnpm preflight:release` kullanılır. Baseline mod promotion koşullarından
bağımsız kalır. Release evidence ayrıca
dependency lock hash'i, komut, zaman ve sonuç artefaktını taşır.

Vercel'de `contour-arc` projesi ve production alias'ı aktiftir. Aşağıdaki liste
tamamlanmış ilk baseline deploy'un tarihsel kaydıdır; güncel production state'ini anlatmaz.
İlk baseline deploy şu özelliklerle yapılmıştı:

- `.env`, keystore ve yerel secret'lar upload kapsamı dışında;
- `PRIVATE_CANDIDATE_MODE=false`;
- `PRODUCT_LIVE_RELEASE=false`;
- issuer secret'ları boş;
- yalnız read-only configured/paused arayüz yayımlanmıştı;
- deployment sonrası `/`, `/developers`, `/admin`, `/api/manifest` ve readiness negatif
  senaryosu browser/API ile doğrulanmıştı.

Bu tarihsel baseline deployment, o aşamada on-chain unpause veya canonical `active`
promotion yetkisi vermemişti.

## 5. Stateless issuer ve tek EOA signer hazırlığı

Core issuer PostgreSQL, KMS veya ayrı bir backend servisi gerektirmez. Vercel server
route'ları request state'i saklamadan çalışır. Aktivasyon öncesinde:

1. `REGISTRATION_PERMIT_SIGNER_PRIVATE_KEY` yalnız server-side secret olarak sağlanır;
   `REGISTRATION_CHALLENGE_SECRET` yalnız compatibility challenge route'u ayrıca
   etkin tutulacaksa en az 32 karakterlik rastgele secret olarak oluşturulur;
2. `REGISTRATION_PERMIT_SIGNER_PRIVATE_KEY` exact funded deployer/owner/treasury EOA
   key'idir; bu bilinçli Arc Testnet sadeleştirmesi manifest ve on-chain state'te açıkça
   doğrulanır;
3. derived signer address canonical manifest ve controller `permitSigner()` ile exact
   eşleşir;
4. canonical direct `/api/registration/prepare` exact wallet-bound intent, request ID,
   origin/release/fingerprint, current nonce ve kısa TTL negatif testlerinden geçer;
5. direct permit ID request ID, issuance zamanı, exact fingerprint, requester ve current
   controller nonce'undan SHA-256 ile deterministik türetilir; compatibility HMAC secret'ı
   hiçbir output'a girmez;
6. prepare her çağrıda Arc chain/controller/release/profile/pause/signer/policy/quote/
   nonce/availability/allowance state'ini fresh okur;
7. local EIP-712 imzası canonical/on-chain signer'a recover edilmeden response dönmez;
8. aynı ve farklı wallet yarış testinde en fazla bir Arc transaction'ı başarılı olur;
   kaybeden transaction ödeme veya kısmi isim state'i bırakmaz;
9. controller'ın iki aşamalı 24 saat gecikmeli signer replacement'ı ve immediate revoke
   davranışı canonical suite'i rotate/revoke etmeden throwaway fork/release üzerinde test
   edilir; canonical suite'te yalnız non-destructive pause/readiness rehearsal yapılır ve
   güvenli kontrol yoksa clean-redeploy yolu kanıtlanır;
10. Vercel secret erişimi minimum proje üyeleriyle sınırlandırılır, değerler build/runtime
    loglarında redacted tutulur ve rotation sonrası eski deployment'lar kapatılır.

Bu profil normal Arc Testnet runtime'ıdır; ayrı bir execution-mode flag'i yoktur.
Activation canonical manifest, exact release binding, readiness ve on-chain pause
kapılarıyla yönetilir.

## 6. Evidence publication ve promotion

Configured deployment taslakları immutable HTTPS altında yayınlandıktan sonra her dosya
için SHA-256 alınır. Canonical manifest yalnız gerçek URL/hash çiftleriyle güncellenir.
Promotion trust root'ları manifestten kopyalanmaz; CI/operator tarafından bağımsız
tanımlanır:

- approved contract runtime hash map;
- exact reviewer allowlist'i;
- allowed HTTPS evidence host'ları.

### V1 kesim snapshot'ı V2 evidence'dan önce gelir

V2 evidence veya private candidate hazırlanmadan önce retained V1 trust root'u gerçek
on-chain kesimden üretilir. Kesim öncesi template, boş `legacyReleases[]` veya elle
`registrationsPaused:true` yazılmış bir dosya kabul edilmez. Güvenli komut sırası:

```bash
# 1. Kesim öncesi baseline ve owner calldata kontrolü (transaction göndermez).
pnpm preflight:release
pnpm admin:activation \
  --manifest deployments/5042002.legacy.json \
  --action controller-pause

# 2. Yalnız V1 registration'ı pause et; V1 marketplace açık kalır.
pnpm admin:activation \
  --manifest deployments/5042002.legacy.json \
  --action controller-pause \
  --broadcast \
  --confirm-release <exact-v1-release-id>

# 3. Exact receipt tx/block/block-hash ile create-new retained snapshot üret.
pnpm prepare:v1-cutover-manifest \
  --manifest deployments/5042002.legacy.json \
  --pause-transaction <v1-pause-transaction-hash> \
  --cutover-block <confirmed-cutover-block> \
  --cutover-block-hash <confirmed-cutover-block-hash> \
  --output deployments/local/5042002-v1-cutover.json

# 4. Aynı block'ta inventory/listing/liability/balance ekonomik snapshot'ını al.
pnpm capture:v1-economic-cutover \
  --manifest deployments/local/5042002-v1-cutover.json \
  --cutover-block <confirmed-cutover-block> \
  --output deployments/local/5042002-v1-economic-cutover.json

# 5. V2 draft'ı yalnız doğrulanmış paused V1 snapshot'ından üret.
node scripts/create-fresh-deployment-template.mjs \
  deployments/local/5042002-v1-cutover.json \
  deployments/local/5042002-v2-draft.json \
  --registrar-version v2

# 6. Keystore/hardware signer ile V2'yi deploy et; iki execution surface paused kalır.
forge script --root contracts \
  script/DeployArcNameServiceV2.s.sol:DeployArcNameServiceV2 \
  --rpc-url https://rpc.testnet.arc.network \
  --account <foundry-keystore-account> \
  --sender <exact-governance-eoa> \
  --broadcast

# 7. Receipt-bound configured manifest ve exact selected-manifest chain snapshot'ı üret.
pnpm prepare:deployment-evidence \
  --broadcast contracts/broadcast/DeployArcNameServiceV2.s.sol/5042002/run-latest.json \
  --manifest deployments/local/5042002-v2-draft.json \
  --output-dir deployments/local/5042002-v2-prepared \
  --registrar-version v2
pnpm capture:configured-state \
  --manifest deployments/local/5042002-v2-prepared/manifest.configured.json \
  --output deployments/local/5042002-v2-configured-chain-state.json
```

`prepare:v1-cutover-manifest` pause receipt'inin success, target, sender, calldata, value,
transaction hash, block number ve block hash'ini; yedi runtime hash'ini; release, owner,
pending owner, wiring, signer/treasury/policy, registry root/reverse-root, USDC decimals,
`registrationsPaused:true` ve V1 marketplace `paused:false` state'ini **o blokta** RPC'den
doğrular. Kaynak manifesti veya canonical dosyaları değiştirmez, mevcut output'un üzerine
yazmaz. `capture:v1-economic-cutover` da aynı verified block'u ister. Bu iki PASS çıktısı
operator review'undan sonra retained snapshot/reference olarak kullanılır.

V2 source verification, ArcScan index, configured evidence publication ve ilk public
evidence-only deployment ancak bu sıradan sonra yapılır. Aşağıdaki private candidate
kurulup exact candidate origin belirlendikten sonra promotion verifier çalışır:

```bash
pnpm verify:promotion -- \
  <active-candidate.json> \
  <active-candidate.promotion.json> \
  --candidate-origin https://<unaliased-candidate-host>
```

### Vercel candidate ve public-live deployment sınırı

Vercel environment senkronizasyonu production scope'a yazdığı için private candidate bir
preview build değildir. Canonical public alias'ı candidate'a taşımadan production
environment ve serverless davranışını sınamak için deployment `--prod --skip-domain` ile
üretilir. Güvenli sıra:

```bash
# 1. Exact V1 pause/cutover ve V2 configured-evidence PASS sonrasında kanıtları
#    public V1/evidence-only hosta yayımla; candidate credential'larını temiz tut.
pnpm sync:vercel-release-env -- --mode public
npx vercel@50.28.0 deploy --prod --yes

# 2. Gitignored .local-keystores/release-activation.env hazırken
#    production-target, alias almayan private candidate oluştur.
pnpm sync:vercel-release-env -- --mode private-candidate
npx vercel@50.28.0 deploy --prod --skip-domain --yes

# 3. Operational gate'ler PASS ise active + productLive:false V2 için
#    credential'sız ayrı public build/deployment üret.
pnpm sync:vercel-release-env -- --mode public
npx vercel@50.28.0 deploy --prod --yes

# 4. Final product-live manifest ve exact binding hazırlandıktan sonra
#    candidate credential'larını kaldır ve ayrı public-live build/deployment üret.
pnpm sync:vercel-release-env -- --mode public-live --binding <releaseId:manifestSha256:verifiedAtBlock>
npx vercel@50.28.0 deploy --prod --yes
```

Birinci deployment yalnız immutable V2 evidence publication'ını ekleyen source state'inden
yapılır. Bu aşamada V1 registration kesim gereği paused, V1 marketplace ve mevcut
read/renew/transfer/exit yolları açıktır; henüz V2 execution veya product-live iddiası yoktur. İkinci
deployment'ın benzersiz URL'si anonymous olarak bütün yollar için `401 + Basic challenge`
vermelidir; canonical alias birinci public deployment'ta kalır. Üçüncü adım yalnız
operational acceptance PASS sonrasında V2'yi `active + productLive:false` olarak public
yapabilir; bu G99 veya evidence-complete iddiası değildir. Dördüncü adım farklı manifest,
`PRODUCT_LIVE_RELEASE` ve credential seti kullandığından yine **ayrı bir build ve deployment**
olmak zorundadır. Private candidate'a `vercel promote` uygulanmaz ve candidate URL'si
canonical alias'a bağlanmaz. Operational-public ve final public-live deployment'larda
`PRIVATE_CANDIDATE_MODE`,
`PRIVATE_CANDIDATE_INGRESS_USERNAME` ve `PRIVATE_CANDIDATE_INGRESS_PASSWORD` bulunamaz;
`PRIVATE_CANDIDATE_MODE=false` bile kalıntı sayılır ve build/runtime fail-closed olur.
Anonymous public health yeniden doğrulanır.

### İki aşamalı private-candidate bootstrap

Candidate Basic auth arkasındaki issuer ilk deploy'dan önce health-check edilemez. Build bu
daireselliği public-live gate'lerini gevşetmeden iki açık aşamaya böler:

1. `active + productLive:false` manifest ve `PRIVATE_CANDIDATE_MODE=true` ile
   `pnpm verify:promotion:ci`, exact manifest digest'ine bağlı `liveVerified:false` ve
   `checkedAtBlock:null` attestation üretir veya aynı exact artefaktı korur. Bu bootstrap
   yalnız izole candidate build'ine izin verir; promotion PASS, issuer readiness evidence'i
   veya public-live iddiası değildir.
2. İlk candidate manifest controller ve marketplace pause state'lerini `true` taşıyabilir;
   readiness/prepare on-chain pause'u yeniden okuduğu için registration `503` ve execution
   fail-closed kalır. Tek owner EOA controller unpause sonrasında candidate manifest controller
   pause'u `false`, marketplace pause'u `true` olarak güncellenir; yeni digest için
   bootstrap deploy yapılır. Ardından [`REGISTRATION_ACTIVATION_SMOKE.md`](REGISTRATION_ACTIVATION_SMOKE.md)
   içindeki `pnpm smoke:registration` önce read-only `NOT_EXECUTED` planı, sonra exact release
   ID/registrant teyitli iki-transaction broadcast olarak çalıştırılır. Schema `1.0.0`
   `registrationActivationSmoke/PASS`, on bir assertion ve marketplace'in hâlâ paused olduğunu
   kanıtlamadan marketplace aynı owner EOA'nın ayrı işlemiyle açılmaz. Bu gate daha sonraki
   `fundedEndToEnd` kabul raporunun yerine geçmez.
3. Exact candidate deploy edildikten ve controller readiness `200` dönebildikten sonra
   trusted operator `PROMOTION_CANDIDATE_INGRESS_USERNAME/PASSWORD` alanlarını sağlar ve
   aşağıdaki komutu çalıştırır:

   ```bash
   pnpm verify:promotion -- \
     <active-candidate.json> \
     <active-candidate.promotion.json> \
     --candidate-origin https://<unaliased-candidate-host>
   ```

   Normal verifier Arc receipt/runtime/wiring,
   immutable evidence, tek-EOA authority policy ve Basic-korumalı issuer health endpoint'ini kontrol
   eder. PASS, exact `liveVerified:true` attestation yazar; sonraki private-candidate CI
   build'leri manifest digest'i değişmedikçe bu sonucu korur.
4. Candidate controller/marketplace açık, issuer-ready ve live-only artifact alanları hâlâ
   `null` iken exact future block'a bağlı, yayımlanamaz target intent üretilir:

   ```bash
   pnpm prepare:promotion-target-intent \
     --manifest <active-market-open-candidate.json> \
     --verified-at-block <later-pinned-block> \
     --output <promotion-target-intent.json>
   ```

   Intent block'u candidate `verifiedAtBlock` değerinden büyük ve broadcast öncesi Arc
   head'inden ileri olamaz. `promotionTargetIntent` yalnız candidate manifest hash'ini,
   projected product-live execution digest'ini, exact target block'u ve promotion subject'i
   bağlar. Deployment manifest değildir, public'e deploy/yayın edilemez ve eksik
   `fundedEndToEnd`/`operationsDrill` için sahte URL/hash taşımaz.
5. Funded acceptance exact candidate ve intent ile çalıştırılır:

   ```bash
   pnpm acceptance:funded \
     --manifest <active-market-open-candidate.json> \
     --target-intent <promotion-target-intent.json> \
     --candidate-origin <https://private-candidate-host> \
     --candidate-basic-auth-file <one-line-user-colon-password-file> \
     --label <available-normalized-label> \
     --broadcast <exact-release-id> \
     --output <new-funded-run.json>
   ```

   Root `.env` içindeki distinct funded seller/buyer hesapları kullanılır. Broadcast
   olmadan komut read-only `DRY_RUN` üretir ve explicit `--target-intent` yoksa promotion
   subject bağlamaz. Başarılı broadcast raporu `fundedEndToEnd`, `schemaVersion: "1.0.0"`,
   `verdict: "PASS"` biçimindedir; bu rapor reviewer envelope'u değildir.
6. Operations drill tek broadcast invocation'ıdır:

   ```bash
   pnpm drill:operations --broadcast \
     --manifest <active-market-open-candidate.json> \
     --target-intent <promotion-target-intent.json> \
     --confirm-release <exact-release-id> \
     --candidate-url <https://private-candidate-host> \
     --output <new-operations-pass.json>
   ```

   Çıktı `operationsDrill`, `schemaVersion: "1.0.0"`, `verdict: "PASS"` olur. Dört canonical
   pause/unpause receipt'ini, readiness kapanma/geri gelme assertion'larını ve exact evidence
   block'u promotion target'a bağlar. Hata halinde iki execution surface fail-safe olarak
   yeniden pause edilir; rapor `flag: wx` nedeniyle mevcut dosyanın üzerine yazılmaz.
7. Bu operations PASS yalnız canonical pause/unpause ve readiness recovery kapsamını kanıtlar.
   Throwaway release üzerinde 24 saatlik signer activation/
   rotation/revoke, clean-redeploy rehearsal ve şifreli/offline key recovery kanıtı bugün
   mevcut değildir. Bu eksikler immutable ve reviewer tarafından incelenmiş evidence'e
   bağlanana kadar G90/G99 `BLOCKED` kalır; operations envelope'u imzalanıp public-live
   kanıtı diye yayımlanmaz.
8. Bütün gerekli run ve recovery raporları immutable yayımlandıktan sonra bağımsız reviewer,
   aynı target intent'e bağlı envelope'ları üretir:

   ```bash
   pnpm sign:promotion-pass \
     <active-market-open-candidate.json> <promotion-target-intent.json> \
     fundedEndToEnd <funded-run.json> \
     <immutable-funded-run-url> <new-funded-envelope.json>

   pnpm sign:promotion-pass \
     <active-market-open-candidate.json> <promotion-target-intent.json> \
     operationsDrill <operations-pass.json> \
     <immutable-operations-run-url> <new-operations-envelope.json>
   ```

   Reviewer key'i yalnız `PROMOTION_REVIEWER_PRIVATE_KEY` environment alanından okunur;
   governance/deployer hesabıyla aynı olamaz. Envelope'lar immutable yayımlanıp exact
   SHA-256'ları alındıktan sonra gerçek product-live manifest, sahte placeholder olmadan
   aynı intent block'u ve gerçek URL/hash çiftleriyle hazırlanır:

   ```bash
   pnpm stage:release \
     --input <active-market-open-candidate.json> \
     --output <product-live-target.json> \
     --phase product-live \
     --target-intent <promotion-target-intent.json> \
     --verified-at-block <same-target-intent-block> \
     --funded-end-to-end-url <immutable-funded-envelope-url> \
     --funded-end-to-end-sha256 <exact-funded-envelope-sha256> \
     --operations-drill-url <immutable-operations-envelope-url> \
     --operations-drill-sha256 <exact-operations-envelope-sha256>
   ```

   Stage raporundaki `promotionExecutionTargetSha256` ve `promotionSubjectSha256` intent ile
   exact eşleşmezse release durur.
9. Operator `PROMOTION_AUTHENTICATED_CANDIDATE_SOURCE=true` ve candidate Basic
   credential'larıyla final `productLive:true` manifest için canonical alias'a dokunmadan
   aşağıdaki komutu çalıştırır:

   ```bash
   pnpm verify:promotion -- \
     <product-live-target.json> \
     <product-live-target.promotion.json> \
     --candidate-origin https://<same-unaliased-candidate-host>
   ```

   Verifier önce aday origin'deki aynı issuer path'inin auth olmadan `401 + Basic challenge`
   verdiğini, sonra authenticated candidate payload'ında yalnız rollout-faz farkını kabul
   ettiğini kanıtlar; chain, controller, release, normalization, signer ve policy alanları
   target ile exact kalır. PASS exact target digest'i için `liveVerified:true` attestation
   üretir.
10. Product-live CI yalnız exact canlı attestation'ı tüketir; bootstrap attestation'ı veya
    candidate digest'ini kabul etmez. Next build exact `PRODUCT_LIVE_RELEASE` ister,
    `PRIVATE_CANDIDATE_MODE` ile candidate credential'larını reddeder; flag'in `false`
    değeri de kabul edilmez, anahtarların tamamı environment'tan silinmiş olmalıdır. Candidate manifesti
    ve credential seti finalden farklı olduğu için aynı artifact promote edilmez; public-live
    ayrı build/deployment olarak üretilir ve deploy sonrası public health operator
    credential'ı olmadan yeniden doğrulanır.

Web runtime, `active + productLive:false` manifest için `PRODUCT_LIVE_RELEASE` exact binding
aramaz. Exact release/digest/attestation environment binding'i ve candidate-source credential
reddi yalnız manifest `productLive:true` olduğunda uygulanır. Yukarıdaki
`PRIVATE_CANDIDATE_MODE` bootstrap akışı yalnız açık promotion-candidate prosedürüne aittir;
mevcut public operational runtime için product-live iddiası oluşturmaz.

Manifestteki herhangi bir değişiklik attestation'ı digest üzerinden geçersiz kılar.
`productLive:true` build bootstrap yolunu hiçbir zaman kabul etmez; target prosedürünün
doğruladığı signed funded E2E/operations-drill gate'leri olmadan exact canlı attestation
üretilemez.

Doğrulayıcı chain ID, positive block receipt'leri, current/historical runtime code,
constructor wiring, tek EOA owner/treasury/signer ve boş `pendingOwner` state'ini,
registrar controller history, immutable artefakt hash'leri ve issuer readiness parity'sini
yeniden okur. PASS olmadan `verified` veya `active` yazılmaz.

## 7. Kontrollü aktivasyon prosedürü

Activation tek adım değildir ve aşağıdaki sırada yürütülür:

1. `pnpm preflight:release` çalıştırılır. V1 name/owner/expiry, açık listing,
   liability/balance ve yedi contract identity'si kesim öncesi pinned block'ta reconcile
   edilir. Retired Safe-owned adreslerin yeni release'te kullanılmayacağı doğrulanır.
2. Owner dry-run çıktısı incelendikten sonra yalnız V1 controller registration pause edilir.
   Exact receipt transaction/block/block-hash ile `prepare:v1-cutover-manifest`, ardından aynı
   block ile `capture:v1-economic-cutover` çalıştırılır. Yedi V1 runtime hash'i, mevcut name
   inventory, açık listing, liability, claim balance ve V1 marketplace `paused:false`
   doğrulanmadan devam edilmez. Her iki araç create-new çıktı üretir; checked-in canonical
   dosyaları kendiliğinden değiştirmez.
3. V2 draft yalnız bu paused V1 çıktısından oluşturulur. Yeni V2 release ID ile yedi kontrat
   funded EOA owner/treasury ve canonical metadata base URI kullanılarak temiz deploy edilir;
   V2 controller ile marketplace paused tutulur. Receipt-bound manifest, source/ABI,
   runtime/wiring ve `capture:configured-state --manifest <v2-configured.json>` evidence'ı
   tamamlanıp immutable/hash-pinned public artefaktlara dönüştürülür.
4. Aynı funded EOA key'inin server-only signer kopyası Vercel runtime'a sağlanır; recovered
   signer, exact origin/release ve negative secret-leak testleri permit issuance olmadan
   geçer. Compatibility challenge route'u tutuluyorsa ayrı HMAC secret'ı da aynı server-only
   sınırda yönetilir.
5. V2 kanıtları public canonical V1/evidence-only deployment'ta yayımlanır. Bu sırada V1
   registration intentionally paused, V1 marketplace/read/renew/transfer/exit yolları açık,
   V2 execution ise kapalıdır. Sonra paused V2 web adayı production target'a `--skip-domain`
   ile deploy edilir. Candidate'ın bütün ingress'i Basic Auth arkasındadır; retained read,
   admin, metadata ve rollback yüzeyleri authenticated olarak doğrulanır.
6. Exact retained reference'a bağlı
   `active + productLive:false + permitIssuer.active:true` manifest hazırlanır ve issuer ile
   Basic-auth korumalı web aynı staged digest / `PRIVATE_CANDIDATE_MODE=true` ile production
   target'a yeniden `--skip-domain` kullanılarak deploy edilir. Public canonical alias güvenli
   V1/evidence-only deployment'ta kalır. V2 controller hâlâ paused olduğu için readiness
   `503`; diğer parity alanları PASS olmalıdır.
7. Exact V2 controller calldata/value/policy digest'i operator tarafından incelenir; ikinci
   blockchain owner imzası gerekmez.
8. V2 controller registration tek owner EOA transaction'ıyla unpause edilir.
9. Receipt + V1-paused/V2-open on-chain state birlikte kontrol edilir; issuer readiness hemen
   `200` olmalıdır. Değilse önce V2 tekrar pause edilir. V1 ancak V2 pause receipt'i ve state'i
   doğrulandıktan sonra rollback kapsamında yeniden açılabilir.
10. [`pnpm smoke:registration`](REGISTRATION_ACTIVATION_SMOKE.md) önce read-only preflight,
   sonra exact release/registrant teyitli iki-transaction broadcast olarak çalışır. On bir
   assertion permit single-use, nonce, exact controller USDC delta, consumed allowance,
   solvency, owner/resolver/expiry, issuer reconciliation ve marketplace pause parity'sini
   doğrular; yalnız schema `1.0.0` `registrationActivationSmoke/PASS` kabul edilir.
11. Registration PASS olmadan V2 marketplace açılmaz. Marketplace aynı owner EOA'nın ayrı
    transaction'ıyla unpause edilir ve list/buy/cancel/claim/solvency smoke çalıştırılır.
    V1 marketplace unpaused, mevcut listing/purchase ve cancel/claim/invalidate exit yolları
    erişilebilir kalır. V1 isim ownership'i veya registrar token'ları taşınmaz.
12. Alias almayan candidate deployment'ın canonical manifesti atomik olarak
    `active + productLive:false` stage edilir; public canonical host hâlâ güvenli
    V1/evidence-only deployment'tadır. Candidate manifest exact V1 release ID/block/address/
    runtime hash'leri ile `registrationsPaused:true` ve `marketplace.paused:false`
    policy'sini `legacyReleases[]` içine digest-bound gömer. Registration/market smoke,
    live candidate verifier ve operational gate'ler PASS ise aynı state candidate
    credential'ları kaldırılmış **ayrı** public build ile operational-public yapılabilir;
    `productLive:false` korunur ve G99/evidence-complete iddiası yapılmaz.
13. Exact later block'a bağlı, non-publishable `promotionTargetIntent` üretilir; funded
    runner ve operations broadcast aynı intent'i kullanır.
14. Operations broadcast dört canonical pause/unpause receipt'i ve readiness recovery
    assertion'larıyla schema `1.0.0` PASS raporu üretir; bu tek başına signer recovery gate'i değildir.
15. Gerçek funded browser E2E; throwaway release üzerinde 24 saatlik signer activation/
    rotation/revoke; clean-redeploy rehearsal ve şifreli/offline key recovery kanıtı
    immutable olarak tamamlanır. Bu kanıtlar bugün eksik ve gate `BLOCKED`'dır; eksikken
    operations reviewer envelope'u üretilmez.
16. Bağımsız reviewer signed envelope'ları yayımlandıktan sonra gerçek URL/hash'lerle final
    product-live manifest hazırlanır, intent digest'leriyle exact eşleştirilir ve promotion
    verifier PASS olur. Ancak bu noktada exact CI/Vercel commit binding'iyle
    `pnpm preflight:release:strict` çalıştırılır; strict preflight hiçbir unpause işleminin
    ön şartı olarak daha erken kullanılmaz.
17. `public-live` environment senkronizasyonu candidate credential'larını kaldırıp web ve
    issuer'ı aynı exact `PRODUCT_LIVE_RELEASE` değerine bağlar. Değişen manifest/environment
    nedeniyle private candidate promote edilmez; ayrı production build/deployment canonical
    alias'a atomik olarak alınır.
18. Public ingress/WAF policy'si ve doğrudan internal-header spoofing negatif testleri
    geçtikten sonra `productLive:true` iddiası korunabilir. Uygulama
    doğrulanmış bir client-identity header'ı implement etmediğinden böyle bir identity
    kontrolü varmış gibi kanıt üretilmez.

Owner transaction'ı ilgili gate'ten önce imzalanmaz veya gönderilmez.

## 8. BENS ve hosted ArcScan

BENS core activation'dan ayrı bir capability'dir. Core issuer'ın PostgreSQL kullanmaması
BENS altyapısını değiştirmez: Graph Node/BENS kendi PostgreSQL veritabanı, migration/
backup/restore policy'si ve ayrı operatör erişimiyle kurulmalıdır. Açılabilmesi için:

1. immutable Graph Node/IPFS/PostgreSQL/BENS image digest'leri;
2. exact positive start block'tan fatal-error-free full replay;
3. subgraph head/chain head lag sınırı;
4. normalized label plaintext ve event mapping fixture parity;
5. BENS health/domain/address/lookup/batch endpoint testleri;
6. aynı pinned block'ta direct RPC ownership/resolver/expiry parity;
7. backup/restore ve reorg drill'i;
8. public HTTPS BENS ve exact
   `/subgraphs/name/contour-arc-testnet` endpoint bağları gerekir.

`ops/bens/render-config.mjs`, yalnız product-live ve live-verified manifest ile bu config'i
üretir; configured/paused manifesti bilinçli olarak reddeder. Hosted ArcScan names
aktivasyonu ayrıca Blockscout/ArcScan operator confirmation ve canlı fixture gerektirir.

## 9. x402 kapsamı

x402 ve direct EIP-3009 Release 1'de tasarım gereği kapalıdır. Core name registration
ürününün canlı olması x402'yi aktif etmez. x402 için ayrı release, managed transaction
signer, durable outbox/order state, idempotency, settlement/registration reconciliation,
refund/compensation liability ledger, spend/allowlist policy ve funded failure matrix'i
gereklidir. Bu kanıtlar olmadan listener mount edilmez ve `x402.active` false kalır.

## 10. Rollback

Her aktivasyon penceresinde geri alma sırası hazır tutulur:

1. issuer'da yeni V2 challenge/permit issuance kapatılır;
2. V2 controller registration tek owner EOA ile pause edilir ve state doğrulanır;
3. V2 marketplace execution pause edilir; cancel/claim yolları korunur. V1 marketplace ve
   exit işlemleri yalnız V1'e özgü ayrı bir incident varsa pause edilir; V1 registration
   her durumda paused kalır;
4. web executable aksiyonları kapanır, read-only durum sayfası açık kalır;
5. Son issuance penceresindeki Arc receipt, `usedPermit`, nonce ve owner state'i reconcile edilir;
6. challenge/EOA/ingress secret'ları gerekirse rotate edilir; EOA güvenli değilse yeni
   release ile temiz redeploy yapılır;
7. incident ve rollback receipt'leri immutable, secret-redacted evidence'e bağlanır;
8. ilgili gate yeniden PASS olmadan reopen yapılmaz.

## 11. Canlılık tanımı

Bir URL'nin açılması, Vercel deployment'ın başarılı olması, kontratların source verified
olması veya tek EOA owner'lığının atanması tek başına “canlı” değildir. Contour ancak şu
koşullar birlikte sağlandığında public-live kabul edilir:

- canonical manifest `active` ve `productLive:true`;
- promotion verifier PASS;
- permit issuer `active` ve readiness `200`;
- V2 controller ve marketplace on-chain unpaused;
- retained V1 reference exact eşleşmiş, V1 registration paused ve V1 marketplace/escape
  yolları açık;
- V2 ERC-721 Metadata interface'i ve exact production metadata base URI doğrulanmış;
- exact `PRODUCT_LIVE_RELEASE` web/issuer binding'i;
- funded E2E ve operations drill signed `PASS`;
- deployment ingress/WAF policy'si aktif; client-supplied internal header'lar
  identity/authentication sayılmıyor;
- rollback/redeploy prosedürü doğrulanmış.

BENS, hosted ArcScan names ve x402 kendi capability kanıtları olmadan ayrıca kapalı
kalabilir; core ürün canlılığı bu bağımsız özelliklerin durumunu yanlış gösteremez.
