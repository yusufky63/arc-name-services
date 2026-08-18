# Acceptance ve Release Kanıt Matrisi

> Baseline tarihi: 16 Temmuz 2026; deployment snapshot'ı 17 Temmuz 2026.  
> Bu belge test planıdır. “Kod mevcut” veya “unit test yazıldı” kanıtın çalıştırıldığı
> anlamına gelmez. Yeni tek-EOA suite Arc Testnet'e 15/15 successful transaction ile
> deploy edilmiştir. Bu exact yedi adres için ArcScan source/ABI doğrulaması 7/7 PASS'tir;
> aşağıdaki 17 Temmuz tablosu aktivasyon öncesi tarihsel baseline'dır, güncel runtime
> özeti değildir. 18 Temmuz canonical manifesti `active`; controller/marketplace unpaused
> ve issuer active'dir. `productLive:false`, funded E2E/operations drill, BENS ve hosted
> ArcScan kapılarının hâlâ tamamlanmadığını gösterir. Retired suite'in eski 7/7 ArcScan
> evidence'ı yeni release için kullanılmaz.

Manifest parser'ı address/block/tx/runtime hash bütünlüğünü, immutable URL/hash
çiftlerini, policy alanlarını ve tek EOA authority evidence şeklini doğrular. `pnpm verify:promotion`
ayrıca bounded artefakt indirme/hash, Arc chain/block, deployment receipt, evidence/latest
runtime code, ABI surface, contract wiring, independent contract hash trust roots,
exact funded-EOA owner/treasury/signer parity ve boş `pendingOwner`, controller history,
signer/policy ve aktif issuer health parity kontrollerini çalıştırır. Public-live
`fundedEndToEnd`/`operationsDrill` için non-circular promotion-subject digest'ine bağlı,
independently allowlisted reviewer tarafından imzalanmış exact `PASS` envelope'u da
doğrular. Buna rağmen bu matristeki gerçek fonlu browser/BENS/operasyon run'ını üretmez.
Artefakt şemaları, receipt retention ve immutable publication kuralları
[`EVIDENCE_POLICY.md`](EVIDENCE_POLICY.md) içindedir.

Canonical public UI, OpenAPI, hosted MCP ve funded acceptance tek adımlı
`POST /api/registration/prepare` akışını kullanır; wallet `personal_sign` challenge'ı yoktur.
`/api/registration/challenge` HMAC/expiry/wallet-recovery matrisi yalnız geriye uyumluluk
yüzeyini korur. `REGISTRATION_CHALLENGE_SECRET` bulunmaması canonical issuer readiness'ini
başarısız yapmaz; readiness signer key/recovery, manifest/on-chain parity, policy, pause ve
RPC durumuna bağlıdır.

## Tarihsel deployment kanıt snapshot'ı — 17 Temmuz 2026

Bu tablo release gate sonucu veya güncel runtime durumu değildir; 17 Temmuz'da elde olan
configured-state girdilerini o tarihte eksik promotion girdilerinden ayırır. Güncel capability
durumu her zaman [`deployments/5042002.json`](../deployments/5042002.json) ve Arc RPC'den okunur.

| Alan | 17 Temmuz 2026 durumu | Release etkisi |
| --- | --- | --- |
| Yedi contract address/tx/block/runtime hash | Manifestte kayıtlı | `configured`; activation kabulü değildir |
| Raw Foundry broadcast/receipt | Repository evidence dizininde hash-pinned kopya var | Offline deployment girdisi; tek başına PASS değil |
| Retired Safe-owned suite | Eski adres/release/source evidence kayıtlı | Superseded; threshold imzaları olmadan tek EOA'ya çevrilemez, activation adayı değildir |
| Yeni tek EOA authority | Deployer/owner/treasury/permit-signer `0x78de409a6306550882328E2a67160471368387FF` | Clean deploy 15/15 başarılı; immutable parity/promotion evidence bekliyor |
| Controller/marketplace | İkisi de pause | Güvenli configured aday; registration/market public değil |
| ArcScan source verification + ABI | Yeni suite 7/7; constructor args broadcast ile eşleşiyor | C19 `PASS` |
| Manifest ABI/source evidence | Yeni exact yedi adres için API URL/response hash indeksi hazır; immutable activation hosting bekliyor | C19 `PASS`, G22 `BLOCKED` |
| Verification block + activation artefaktları | `null` | `verified` state'e geçilemez |
| Stateless permit issuer/signer | Issuer inactive; signer secret ve readiness/revoke drill kanıtı yok; compatibility challenge HMAC kanıtı ayrıca yok | G30/G31 `BLOCKED` |
| BENS/hosted ArcScan | Bütün capability flag'leri false | G60/G61 `BLOCKED` |
| Product live | `productLive:false` | G99 `BLOCKED` |

## Durum sözlüğü

| Durum | Anlamı |
| --- | --- |
| `SPECIFIED` | Gereksinim tanımlı; run artefact/evidence henüz iliştirilmemiş |
| `BLOCKED` | Deployment, external operator veya henüz olmayan authority gerekiyor |
| `DISABLED` | Bilinçli ürün kararıyla execution kapalı |
| `PASS` | Tarihli, tekrar üretilebilir evidence linki mevcut |
| `FAIL` | Evidence gate'i karşılamıyor; release durur |
| `N/A` | Bu release kapsamı dışında; gerekçe zorunlu |

`PASS` yalnız command, commit SHA, dependency lock hash, environment/chain, timestamp
ve sonuç artefaktı birlikte tutulduğunda kullanılabilir.

`pnpm preflight:release` canonical RPC, `.vercelignore`, exact
`pnpm packages:build && pnpm --filter @contour/web build` profili ve bilinen local secret
değerlerinin source izolasyonunu kontrol eder. `pnpm preflight:release:strict` ayrıca
`active + productLive:true`, hash-pinned `fundedEndToEnd`/`operationsDrill`, temiz worktree,
çözümlenebilir Git HEAD ve bu HEAD ile exact eşleşen aktif GitHub Actions/Vercel deployment
commit bağını zorunlu tutar. Bu preflight yine dependency lock hash'i, komut, zaman ve sonuç
artefaktından oluşan tam PASS metadata'sının yerine geçmez.

## Release gate özeti

| Gate | Alan | Kabul ölçütü | Başlangıç durumu |
| --- | --- | --- | --- |
| G00 | Marka/namespace | Contour/`.contour` trademark, domain ve namespace collision review | `BLOCKED` |
| G01 | Spec/evidence | Normatif spec, threat model, resmi kaynak/çelişki kaydı review edilmiş | `SPECIFIED` |
| G02 | Dependency supply chain | Exact lock, license/vulnerability review, focused dependency-closure build ve dated preflight evidence | `SPECIFIED` |
| G10 | Normalization | ENSIP-15 corpus UI/SDK/issuer/contract/subgraph parity | `SPECIFIED` |
| G20 | Contract suite | Unit/fuzz/invariant/security review başarılı | `SPECIFIED` |
| G21 | Arc USDC | Live shared-balance + dual-event + blocklist fixtures başarılı | `BLOCKED` |
| G22 | Deployment | Yeni `0x66aeb7…defdc` release clean deploy edildi; immutable source/ABI, independent runtime trust roots, controller history ve exact single-EOA policy promotion-verified | `BLOCKED` |
| G30 | Permit issuer | Direct `/api/registration/prepare` için fresh Arc/intent parity, signer secret/recovery, overload/body/edge limits ve rotate/revoke evidence; compatibility route için ayrıca HMAC tamper/expiry ve wallet recovery | `SPECIFIED` |
| G31 | Direct funded E2E | MetaMask/Rabby desktop/mobile approval+register+receipt | `BLOCKED` |
| G40 | Web/SDK/React | chain/add/switch/disconnect/error/accessibility/browser matrix | `SPECIFIED` |
| G50 | Marketplace | fixed listing/buy/invalidation/claim/solvency funded E2E | `BLOCKED` |
| G60 | Self-hosted BENS | ayrı operator + kendi PostgreSQL'i, exact-block replay, sync, API ve direct-RPC parity | `BLOCKED` |
| G61 | Hosted ArcScan | operator activation + live name/address search | `BLOCKED` |
| G70 | MCP | read/unsigned-plan only, no secret/sign/broadcast | `SPECIFIED` |
| G71 | ERC-8004 | optional display, forward-confirmed, fail-soft | `SPECIFIED` |
| G80 | Direct EIP-3009 | Ayrı capability review | `DISABLED` |
| G81 | x402 | Funded settlement/compensation/reconciliation/security review | `DISABLED` |
| G90 | Operations | pause/revoke, receipt recovery, 24h signer rotation, clean-redeploy, offline recovery ve incident runbooks | `BLOCKED` |
| G99 | Release | Bütün required gates PASS; signed promotion verification başarılı; exact `PRODUCT_LIVE_RELEASE`, deployment ingress/WAF policy ve header-spoof negatifleri, manifest `active` + `productLive` + issuer readiness atomik yayınlanmış | `BLOCKED` |

## Contract matrisi

| ID | Test/invariant | Zorunlu evidence | Durum |
| --- | --- | --- | --- |
| C01 | ENS Registry interface ve event conformance | ABI/interface tests + event fixtures | `SPECIFIED` |
| C02 | `tokenId == uint256(labelhash(normalizedLabel))` | corpus golden vectors | `SPECIFIED` |
| C03 | ACTIVE→GRACE→AVAILABLE, 90 gün parity | timestamp boundary tests | `SPECIFIED` |
| C04 | Grace'te yalnız renewal | owner/attacker negative tests | `SPECIFIED` |
| C05 | Transfer registry ownership sync | fuzz/state-machine trace | `SPECIFIED` |
| C06 | Bare register yok | ABI surface assertion | `SPECIFIED` |
| C07 | EIP-712 signature/domain ve aktif issuer yolunda `requester=recipient=payer=executor=sender` binding | positive + copied calldata/compromised signer/farklı recipient negatif testleri | `SPECIFIED` |
| C08 | wrong chain/controller/release/profile/payer/recipient | full mutation matrix | `SPECIFIED` |
| C09 | issuer TTL ≤295s, 5s skew dâhil controller window ≤300s, default 180s, replay rejection | boundary + usedPermit tests | `SPECIFIED` |
| C10 | price/duration/referral guard payment öncesi | token call spy/negative tests | `SPECIFIED` |
| C11 | ERC-20 exact-delta, revert atomicity | mock + live USDC fixture | `SPECIFIED` |
| C12 | native sweep fonksiyonu yok | ABI/static analysis | `SPECIFIED` |
| C13 | referral liabilities ve surplus solvent | invariant/fuzz | `SPECIFIED` |
| C14 | resolver interface/event parity | ERC-165 + record fixtures | `SPECIFIED` |
| C15 | reverse yalnız forward-confirmed gösterilir | resolver/reverse integration | `SPECIFIED` |
| C16 | marketplace listing/buy/transfer invalidation | race/fuzz/funded fixture | `SPECIFIED` |
| C17 | pull proceeds, pause sırasında cancel/claim | pause/invariant tests | `SPECIFIED` |
| C18 | seller/referral liabilities forced balance ile solvent | native/shared-balance invariant | `BLOCKED` |
| C19 | seven-contract source verification | 7/7 ArcScan v2 API `is_verified:true`, ABI ve hash-pinned snapshot | `PASS` |
| C20 | re-registration state boundary | resolver record version ilerler, registry TTL `0`; failed replacement atomik rollback | `SPECIFIED` |

## Normalization ve pricing matrisi

| ID | Fixture | Kabul | Durum |
| --- | --- | --- | --- |
| N01 | upstream ENSIP-15 version/spec hash | manifest/lock/evidence birebir | `SPECIFIED` |
| N02 | leading/trailing whitespace | trim açıkça gösterilir; başka silent transform yok | `SPECIFIED` |
| N03 | emoji/ZWJ/combining/mixed scripts | UI, issuer, SDK aynı accept/reject/output | `SPECIFIED` |
| N04 | empty/invalid UTF-8/null byte ve `.`, `。`, `．`, `｡` | normalization sonrası dâhil bütün katmanlarda reject | `SPECIFIED` |
| N05 | 63/64 UTF-8 byte/code point | aynı boundary sonucu | `SPECIFIED` |
| N06 | 1/2/3/4 code point pricing | 5.00/2.50/1.00/0.50 USDC | `SPECIFIED` |
| N07 | normalized name→labelhash/namehash/tokenId | golden hash parity | `SPECIFIED` |
| N08 | event/subgraph/BENS preimage | placeholder yok, aynı normalized bytes | `BLOCKED` |
| N09 | dependency/corpus change | new profile hash + release ID required | `SPECIFIED` |

## Stateless permit issuer/signer matrisi

P01, P04, P06–P08, P10, P13'ün direct-prepare kısmı ve P14 canonical issuer'a uygulanır.
P02, P03, P05, P12 ile P09/P11/P13'ün challenge'a özgü bölümleri yalnız
`/api/registration/challenge` uyumluluk yüzeyine uygulanır. Bu kontroller route kullanılırsa
aynı sertlikle geçerlidir; ancak public UI/OpenAPI/hosted MCP/funded flow challenge veya
`personal_sign` üretmez ve canonical readiness challenge secret aramaz.

| ID | Senaryo | Kabul | Durum |
| --- | --- | --- | --- |
| P01 | aynı label'a 100 concurrent request | permit sayısı reservation garantisi değildir; en fazla bir on-chain success, kaybedenlerde sıfır payment/state | `SPECIFIED` |
| P02 | compatibility-only aynı signed challenge/fingerprint retry | state değişmediyse aynı deterministic permit ID/payload; current nonce/availability tekrar okunur, ikinci on-chain success yok | `SPECIFIED` |
| P03 | compatibility-only HMAC envelope bit flip veya aynı challenge ile farklı payload | reject, imza yok | `SPECIFIED` |
| P04 | response loss / belirsiz transaction | yeni permit öncesi receipt, `usedPermit`, nonce, owner ve availability reconciliation | `SPECIFIED` |
| P05 | compatibility-only server restart / yatay instance değişimi | kalıcı issuer state'i olmadan valid challenge doğrulanır; secret/release mismatch yalnız compatibility route'u fail-closed yapar | `SPECIFIED` |
| P06 | signer secret eksik/yanlış veya recovered address mismatch | `503`, permit yok, alarm | `SPECIFIED` |
| P07 | EOA normal rotation | throwaway fork/release üzerinde iki aşamalı 24 saatlik signer activation + owner/treasury/signer parity kanıtlanır; canonical signer değiştirilmez | `BLOCKED` |
| P08 | signer compromise | throwaway fork/release immediate revoke; canonical suite'te non-destructive pause/readiness + clean-redeploy rehearsal | `BLOCKED` |
| P09 | raw label ve compatibility-only challenge/signature logging | API/analytics logları temiz; `/name/*` edge path redact/hash veya path logging kapalı | `SPECIFIED` |
| P10 | canonical direct issuer unavailable | wallet/payment başlamıyor | `SPECIFIED` |
| P11 | issuance audit | permitId/hash/policy version; raw label/private key ve compatibility route'a ait challenge/HMAC yok | `SPECIFIED` |
| P12 | compatibility-only stateless challenge boundary | canonical HMAC; expiry/origin/release/fingerprint/wallet mutation ve signature replay matrix | `SPECIFIED` |
| P13 | overload/body/observability | 16 KiB request cap; compatibility challenge ile canonical preflight/prepare/verify no-queue limits `8/8/4/8`; bounded RPC deadline ve secret-redacted structured logs | `SPECIFIED` |
| P14 | abuse sınırı | edge/WAF + wallet/client burst limits; spoofed forwarded IP authentication sayılmıyor | `SPECIFIED` |

## Arc/wallet/USDC matrisi

| ID | Senaryo | Kabul | Durum |
| --- | --- | --- | --- |
| A01 | RPC chain profile | `5042002`, canonical RPC/WS/explorer | `BLOCKED` |
| A02 | MetaMask add/switch | exact-pinned config, chain doğru | `BLOCKED` |
| A03 | Rabby add/switch | exact-pinned config, chain doğru | `BLOCKED` |
| A04 | wrong chain | tx yok; switch/disconnect erişilebilir | `SPECIFIED` |
| A05 | native vs ERC20 balance | tek asset UI, 18/6 interface doğru | `BLOCKED` |
| A06 | ERC20 transfer event | system + ERC20 stream dedupe | `BLOCKED` |
| A07 | native transfer event | system stream; ERC20 duplicate beklenmiyor | `BLOCKED` |
| A08 | dust <1e-6 | truncation açıklaması/accounting bozulmuyor | `BLOCKED` |
| A09 | receipt status 0 | final failure; success UI yok | `BLOCKED` |
| A10 | receipt status 1 | expected contract/event/state ile success | `BLOCKED` |
| A11 | USDC blocklisted payer/recipient | atomic revert; permit/nonce/payment/name state'i değişmiyor | `BLOCKED` |
| A12 | fee display | USDC network fee; ETH/gwei yok | `SPECIFIED` |

## Web/SDK/MCP matrisi

| ID | Senaryo | Kabul | Durum |
| --- | --- | --- | --- |
| W01 | manifest draft/null addresses | executable action fail-closed | `SPECIFIED` |
| W02 | tamper chain/address/ABI hash | parser/planner reject | `SPECIFIED` |
| W03 | availability/RPC/permit error | ayrı kullanıcı mesajları | `SPECIFIED` |
| W04 | approval gerekli/gereksiz | doğru wallet request disclosure | `BLOCKED` |
| W05 | Modular Typography desktop/mobile | 12/4 grid, sıra korunuyor | `SPECIFIED` |
| W06 | accessibility | keyboard, focus, AA, reduced-motion | `SPECIFIED` |
| W07 | wallet providers coexistence | MetaMask/Rabby conflict yok | `BLOCKED` |
| W08 | MCP secret/sign/broadcast | capability yok + secret scan temiz | `SPECIFIED` |
| W09 | shipped unsigned plan | exact `kind/chainId/to/data/value=0/description`; active-manifest fail-closed | `SPECIFIED` |
| W10 | non-affiliation/testnet copy | Arc/Circle resmîlik iddiası yok | `SPECIFIED` |
| W11 | enriched plan evidence envelope | release/ABI/profile/expiry alanları proposed; shipped diye advertise edilmiyor | `N/A` |
| W12 | candidate/product ingress | bütün candidate ingress Basic auth; anonymous `401 + WWW-Authenticate + no-store`; başarılı auth sonrası `Authorization` ve client-supplied internal header'lar downstream'den siliniyor; `/evidence/**` bypass yok; live exact release binding ve `PRIVATE_CANDIDATE_MODE=false` dahil candidate environment kalıntısı yok | `SPECIFIED` |
| W13 | SDK manifest discovery | out-of-band exact digest/release pin; 256 KiB streaming cap; redirect/credential/fragment reject | `SPECIFIED` |

W12 yalnız issuer health'i değil `/`, statik asset, `/status`, API ve `/evidence/**`
örneklerinin her birini kapsar. Eksik/bozuk candidate configuration `503` ile fail-closed
kalmalıdır. Immutable V2 evidence, private candidate doğrulamasından önce hâlâ public
canonical V1/evidence-only hostta exact URL/hash ile bulunmalıdır; candidate URL'sinde
anonymous evidence istisnası kabul edilmez. Candidate production target'a
`--prod --skip-domain` ile deploy edilir ve canonical alias değişmez. Final public-live,
farklı manifest ve environment binding'i nedeniyle candidate artifact'ini promote etmez;
candidate credential'ları kaldırılmış ayrı build/deployment anonymous olarak erişilebilir
olmalıdır. Final environment'ta candidate flag'i `false` olarak tutulmaz; üç runtime
candidate anahtarının tamamı yoktur.

## BENS matrisi

Manifestteki `protocolConfigured`, `subgraphSynced` ve `hostedArcscanActive`
boolean'ları runtime health kanıtı değildir. Schema ayrı health/parity alanları
taşıyana kadar aşağıdaki sonuçlar bu bölümün immutable operator artefaktlarında
tutulur; manifest flag'i tek başına hiçbir satırı PASS yapmaz.

Core stateless permit issuer'ın PostgreSQL kullanmaması BENS mimarisini değiştirmez.
Self-hosted BENS/Graph Node kendi ayrı PostgreSQL veritabanını, migration/backup/restore
politikasını ve operatörünü gerektirir; bu kaynak core issuer secret'larıyla paylaşılmaz.

| ID | Senaryo | Kabul | Durum |
| --- | --- | --- | --- |
| B01 | subgraph build/codegen | pinned commit ve clean build log | `BLOCKED` |
| B02 | exact deployment blocks | manifestten positive blocks; zero yok | `BLOCKED` |
| B03 | full replay | fatal error yok, expected head/lag | `BLOCKED` |
| B04 | register/renew/transfer | owner/registrant/expiry/cost doğru | `BLOCKED` |
| B05 | resolver/text/reverse | event/entity parity | `BLOCKED` |
| B06 | 90-day grace | contract/web/subgraph aynı | `BLOCKED` |
| B07 | human-readable name | hash placeholder yok | `BLOCKED` |
| B08 | BENS API | health/domain/address/lookup/batch | `BLOCKED` |
| B09 | direct RPC parity | pinned block snapshot eşleşiyor | `BLOCKED` |
| B10 | self-hosted Blockscout search | name↔address görünür | `BLOCKED` |
| B11 | hosted ArcScan search | operator activation + live fixture | `BLOCKED` |
| B12 | expired/unconfirmed reverse | verified primary gösterilmiyor | `BLOCKED` |
| B13 | version/digest/restore | latest yok; backup/rollback drill | `BLOCKED` |
| B14 | re-registration reset events | `VersionChanged` ve `NewTTL(...,0)` derived state'i eski records/TTL'den temizliyor | `BLOCKED` |

## Agent/x402 matrisi

| ID | Senaryo | Kabul | Durum |
| --- | --- | --- | --- |
| X01 | ERC-8004 unavailable | core flow devam; badge yok | `SPECIFIED` |
| X02 | ERC-8004 spoof | owner/address + forward-confirm yoksa verified değil | `BLOCKED` |
| X03 | x402 endpoint release 1 | process startup refusal; route/listener mount, payment veya permit yok | `DISABLED` |
| X04 | Gateway supported-profile discovery | Arc domain/network/asset exact | `DISABLED` |
| X05 | order/payment/permit binding | mutation tests | `DISABLED` |
| X06 | duplicate/timeout/response loss | tek payment/registration | `DISABLED` |
| X07 | settle success/register fail | automatic funded compensation | `DISABLED` |
| X08 | register success/settle fail | seçilmiş risk policy/reconciliation | `DISABLED` |
| X09 | keeper allowlist/spend/pause | arbitrary target/value yok | `DISABLED` |
| X10 | direct EIP-3009 | EOA/EIP1271/replay/blocklist/codehash | `DISABLED` |

## Evidence artefakt sözleşmesi

Bu bölüm PASS kayıtlarının özetini tanımlar; normatif publication/index/retention
sözleşmesi [`EVIDENCE_POLICY.md`](EVIDENCE_POLICY.md)'dir. Yerel repository path'i
configured inceleme için kullanılabilir; manifestin `verified`/`active` alanları yalnız
allowlisted immutable public HTTPS URL + SHA-256 çiftlerini kabul eder.

Her PASS kaydı aşağıdaki metadata'yı taşımalıdır:

```json
{
  "gateId": "A06",
  "commit": "<git-sha>",
  "chainId": 5042002,
  "blockNumber": null,
  "timestamp": "<RFC3339>",
  "command": "<exact command>",
  "dependencyLockSha256": "<sha256>",
  "resultSha256": "<sha256>",
  "artifactUrl": "<immutable URL or repository path>",
  "reviewer": "<identity>"
}
```

Deployment/BENS/Arc fixtures için `blockNumber`, RPC endpoint class, tx hashes ve
relevant contract code hash'leri null olamaz. Secret, raw payment authorization veya
wallet signature evidence artefaktına konamaz.

Public-live run'ları tam manifestteki live-only artefakt URL/hash'leri var olmadan önce exact
product-live subject'e bağlamak için non-publishable `promotionTargetIntent` kullanır. Bu
schema `1.0.0` intent candidate manifest hash'i, execution target digest'i, future
`productLive:true` subject'i ve later verified block'u taşır; deployment manifest değildir,
placeholder URL/hash içermez ve activation artefaktı olarak kullanılamaz.

Public-live `fundedEndToEnd` ve `operationsDrill` URL'lerinin içeriği generic metadata
değil, doğrulayıcının kabul ettiği exact signed envelope olmalıdır:

```json
{
  "schemaVersion": "1.1.0",
  "artifact": "fundedEndToEnd",
  "verdict": "PASS",
  "chainId": 5042002,
  "releaseId": "<bytes32>",
  "promotionSubjectSha256": "<bytes32>",
  "verifiedAtBlock": 1,
  "evidenceBlock": 1,
  "runReportUrl": "https://<immutable-host>/<content-address>/run.json",
  "runReportSha256": "<bytes32>",
  "reviewer": "<address>",
  "signature": "<65-byte signature>"
}
```

`promotionSubjectSha256`, activation artifact URL/hash çiftleri boşlanmış canonical
manifestten hesaplanır; böylece envelope kendi URL/hash'ine circular bağlı değildir,
ama release/contract/governance/policy/product-live intent'i bağlamaya devam eder.
Reviewer adresi manifestten bağımsız CI allowlist'inde olmalı; evidence block verification
block'undan eski veya verifier latest block'undan ileri olamaz.

Funded ve operations envelope'larının işaret ettiği run raporları `schemaVersion: "1.0.0"`
kullanır. İkisi de aynı chain/release/subject/block değerlerini, exact zorunlu işlem ID'lerini, zorunlu
PASS assertion ID'lerini ve secret/signature redaction bildirimini taşır. Promotion verifier
rapor hash'ini ve her transaction'ın başarı receipt'ini, block'unu, gönderenini ve beklenen
protocol/USDC hedefini yeniden doğrular.

Operations broadcast schema `1.0.0` `artifact: "operationsDrill"`, `verdict: "PASS"`
raporunu yalnız dört canonical pause/unpause receipt'i ve readiness kapanma/geri gelme
assertion'ları başarıyla doğrulandığında üretir. Bu PASS yalnız pause/readiness kapsamıdır;
bugün eksik olan
24 saatlik throwaway signer rotation/revoke, clean-redeploy ve offline-recovery kanıtları
tamamlanana kadar G90/G99 `BLOCKED` kalır. Bu nedenle ayrıntısız veya başka bir koşuya ait
generic PASS imzası release gate'ini geçemez.

## Release kararı

Release 1 için required gate'ler: G00, G01, G02, G10, G20–G22, G30–G31, G40,
G50, G70–G71, G90 ve G99. BENS ürün claim'i yapılacaksa G60; hosted ArcScan claim'i
için ayrıca G61 gerekir. G80 ve G81 disabled kalmalıdır.

Herhangi required gate `FAIL`, `BLOCKED` veya yalnız `SPECIFIED` ise operatör
`activationEvidence.productLive:true` yayımlamamalı ve README “product-live” veya
“evidence-complete” diyemez. Canonical `active` state, unpaused policy ve active issuer
operasyonel public Arc Testnet erişimini dürüstçe belgeleyebilir; bu, G99 PASS iddiası değildir.
`active` + `productLive:false` operasyonel olabilir fakat product-live kanıtı değildir. Promotion
verifier chain/runtime/receipt/wiring/role/policy, controller history, bağımsız hash trust
root'ları ve signed PASS envelope'larını yeniden doğrular; fonlu run'ın kendisi yine
immutable evidence olmak zorundadır.
Core manifest `active`, ilgili policy unpaused, `permitIssuer.active` ve readiness parity
birlikte sağlandığında Release 1 registration ürünü operasyonel olabilir. Buna karşılık
public web ve issuer aynı `PRODUCT_LIVE_RELEASE=<releaseId>:<manifestSha256>:<verifiedAtBlock>`
değerini kullanmadan; deployment ingress/WAF policy'si ile doğrudan internal-header spoofing
negatifleri kanıtlanmadan G99/product-live PASS olamaz. Client-supplied internal header
identity/auth sayılmaz. Private-candidate Basic Auth güncel V2 acceptance sınırıdır; bütün
candidate ingress'i korur, fakat final public-live build'de hiçbir candidate credential'ı
ve site password'u bulunamaz.
Bu readiness canonical direct `/api/registration/prepare` signer/on-chain parity'sidir;
compatibility-only `REGISTRATION_CHALLENGE_SECRET` varlığı readiness şartı değildir.
