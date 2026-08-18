# Deployment ve Release Kanıt Politikası

> **V2 rollout boundary (24 July 2026):** the isolated private candidate uses
> whole-site Basic Auth while the canonical host remains public on the safe
> V1/evidence-only deployment. The final public-live build has no site password
> or candidate credentials. Registration and market availability are derived
> from the exact manifest plus current onchain pause state.

Bu belge Arc Testnet release kanıtlarının nasıl üretildiğini, saklandığını, yayımlandığını
ve doğrulandığını tanımlar. Normatif deployment kaydı
[`deployments/5042002.json`](../deployments/5042002.json)'dır. Mevcut release `active`;
controller/marketplace unpaused ve stateless issuer active'dir. Yeni tek-EOA suite 15/15
successful transaction ile deploy edilmiş; yedi exact adresin ArcScan source/ABI doğrulaması,
constructor-argument eşleşmesi ve core activation URL/hash publication'ı tamamlanmıştır.
Retired suite'in eski 7/7 snapshot'ı yeni release'e taşınmaz. Buna karşılık funded E2E,
operations drill, bağımsız product-live reviewer evidence'i, BENS ve hosted ArcScan activation
tamamlanmamıştır; bu nedenle `productLive:false` kalır. ArcScan verification tek başına
`active` veya `productLive` iddiası oluşturmaz; canonical manifest state ve canlı Arc policy
parity ayrı doğrulanır.

## Kanıt katmanları

| Katman | Amaç | Public release yetkisi |
| --- | --- | --- |
| Ham receipt | Foundry broadcast işlemleri ve Arc receipt'lerini byte-for-byte korur | Yok |
| Hazırlanmış deployment raporu | Receipt, constructor argümanları, adresler ve yerel artifact bytecode'unu offline çapraz doğrular | Yok |
| Yayımlanmış immutable artefakt | Credential içermeyen HTTPS URL + SHA-256 ile bağımsız yeniden indirmeyi sağlar | `verified` için gerekli, tek başına yeterli değil |
| Promotion attestation | Canlı Arc RPC, yayımlanmış artefaktlar ve bağımsız trust root'larla release'i yeniden doğrular | İlgili state gate'i için gerekli |
| Fonlu kabul/operasyon kanıtı | Gerçek wallet, USDC, BENS ve incident drill sonuçlarını taşır | `productLive` için ayrıca gerekli |

Core stateless permit issuer için PostgreSQL/KMS evidence'i aranmaz. Bu karar BENS'e
taşınmaz: self-hosted Graph Node/BENS kendi PostgreSQL'i, backup/restore kanıtı ve ayrı
operator accountability'siyle G60 kapsamında doğrulanır. Gelecekteki x402 durable order
state'i de ayrı release ve evidence sözleşmesidir.

Yeni tek-EOA release için repository'de korunan ham ve receipt-hydrated broadcast:

```text
deployments/evidence/5042002/contour-single-owner-v1/foundry-run-raw.json
SHA-256: 0x6752150027d7d0c1e231db48add25a600fda829ff184aec4cc7e08c284946b8d

deployments/evidence/5042002/contour-single-owner-v1/foundry-run-hydrated.json
SHA-256: 0xe603cb9a2a87d5dd43a442cc2379942d5f9c0211511042141bd835f2cb9d7e1f
```

İlk dosya Foundry broadcast'ın exact ham kopyası, ikincisi RPC receipt alanlarıyla hydrate
edilmiş deployment evidence kaynağıdır; ikisi de ArcScan source verification veya canlı state
snapshot'ı değildir. Dosyalar yeniden biçimlendirilmez. Yeniden export gerekiyorsa eski
dosya korunur, yeni dosya farklı checksum ve timestamp ile indexe eklenir.

Güncel release'in ArcScan source/ABI cevapları public API URL'si ve exact response hash'iyle
şu indekste pinlenir:

```text
deployments/evidence/5042002/contour-v1/arcscan-source-verification.json
API: https://testnet.arcscan.app/api/v2/smart-contracts/{address}
```

17 Temmuz 2026 cevaplarının yedisinde de `is_verified:true`, non-empty `abi`, başarılı
creation state'i ve deployment broadcast'ıyla eşleşen constructor argümanları vardır:

| Rol | ArcScan response SHA-256 |
| --- | --- |
| Registry | `0x98ece5e6e4037137e199de45c1799aa53660065bbaf6d103b3dbf8526f00abe1` |
| Base registrar | `0xb92d2fcdb045e74aaab582f62109d184c89ec5e4f944c6fc8cc7df19d282a9c8` |
| Controller | `0x301a569ba72e6a5c8378b9327777958aeeb69dbcbce2179e7d44f613e560dbc8` |
| Public resolver | `0x1f0337e597a2ab7403fe0768a7dcfbe50402d07eda3722ee419f2c74853a6e43` |
| Reverse registrar | `0x3cfb952a4201b0cc5c3b9598e25518a3c824eac0b2c161f655d643cae01e07df` |
| Universal resolver | `0xc11cbd487d5f0b078d08159eea6f3a89f998513570a7b60ca0ee129ca5a8d51f` |
| Marketplace | `0x1a53bdef9c9477aae4b5512112102811b800699bb6a9780680bb97e566fcd182` |

Bu hash-pinned API cevapları ArcScan verification sonucunu kanıtlar. Canonical
manifest aynı public ArcScan API endpoint'lerini ve exact response hash'lerini taşır;
promotion verifier cevapları yeniden indirip hash ve ABI surface'ini doğrular. API cevabı
değişirse eski hash kabul edilmez. Manifestin `verified` gate'i için buna ek olarak bağımsız
runtime trust root'ları, altı non-live activation artefaktı ve pinned-block promotion
doğrulaması gerekir.

Rol/adres/API/UI URL/zaman/hash eşlemesini taşıyan yerel indeks:

```text
deployments/evidence/5042002/contour-v1/arcscan-source-verification.json
SHA-256: 0x659c1c514fbf2ae60919999adfa8c085adf50157b5eb2e194cd16e34c7ab218c
```

`arcscan/` altındaki eski Safe-owned suite snapshot'ları tarihsel kayıttır ve güncel
release index'i tarafından referans edilmez.

Owner/treasury/signer, pause ve wiring state'i tek bir Multicall snapshot'ında ayrıca korunur:

```text
deployments/evidence/5042002/contour-single-owner-v1/configured-chain-state.json
Capture block: 52190647
SHA-256: 0x2d90fc0ae9198f26103420107e434739bdc4d996f5c602a0fdf0513d17ea58e0
Reproduce: pnpm capture:configured-state
```

Komut stdout üretir; mevcut evidence dosyasının üzerine otomatik yazmaz. Yeni capture önce
diff/review edilir, yeni block ve checksum ile ayrı revision olarak korunur. Bu local
snapshot da public `governanceRoles`/`constructorWiring` artefaktlarının yerine geçmez.

Son salt-okunur sağlık capture'ı block `52293452` için
`contour-single-owner-v1/configured-chain-state.block-52293452.json` adıyla ayrı tutulur.
Bu dosya canonical `.network` RPC üzerinden alınmış ve repository'de korunan en son
operasyon snapshot'ıdır; canlı chain head'i veya güncel readiness sonucu olduğu iddia
edilmez ve block `52190647`'ye bağlı immutable public configured publication'ı sessizce
değiştirmez.

## Receipt koruma ve offline hazırlama

1. Broadcast biter bitmez Foundry `run-latest.json` dosyası release dizinine kopyalanır.
2. Kopyada private key, keystore parolası, bearer, RPC credential veya yeniden
   kullanılabilir wallet/payment signature bulunmadığı secret scan ile doğrulanır.
3. SHA-256 kopyalanan exact byte dizisi üzerinden hesaplanır; sonradan pretty-print
   yapılmaz.
4. `pnpm prepare:deployment-evidence --broadcast <path> ...` yalnız offline hazırlama
   aracıdır. Receipt sırasını, yedi direct creation'ı, constructor wiring'ini, positive
   block'ları, unique adresleri ve yerel runtime reconstruction'ı doğrular.
5. Hazırlanan `manifest.configured.json` canonical manifestin yerine otomatik geçirilmez.
   Operator iki dosyayı review eder; zincir sorguları ve owner EOA işlemleri ayrı kanıttır.
6. `pnpm verify:promotion:ci`, `configured` release için non-live attestation üretir veya
   mevcut attestation'ı günceller. Bu çıktı canlı promotion sonucu değildir.

Aynı CI entry point'inin tek, dar bootstrap istisnası vardır: exact
`active + productLive:false` manifest yalnız `PRIVATE_CANDIDATE_MODE=true` iken digest-bound
`liveVerified:false` attestation üretebilir. Bu, Basic-korumalı issuer'ın ilk deploy
daireselliğini çözer; issuer health çalıştırmaz veya iddia etmez, promotion gate'ini geçmez
ve product-live ya da BENS release kontrolünde kullanılamaz. Aynı exact digest için geçerli
attestation zaten varsa CI onu korur; digest değişmişse stale evidence'i kullanmak yerine
yeni non-live bootstrap artefaktı üretir.

Candidate deploy edilmeden önce manifestin referans verdiği bütün immutable V2 kanıtları
hâlâ public canonical hosta, V1 execution davranışını değiştirmeyen review edilmiş
V1/evidence-only deployment ile yayımlanır. Candidate hostta anonymous evidence istisnası yoktur;
kanıt URL'leri private candidate URL'sini kullanamaz.

Deploy sonrasında full candidate promotion, trusted operator shell'de
`PROMOTION_CANDIDATE_INGRESS_USERNAME` ve
`PROMOTION_CANDIDATE_INGRESS_PASSWORD` ile çalıştırılır. Bu server-only CLI alanları çift
olarak tanımlanır ve public/browser environment değişkeni değildir. Bellekte üretilen Basic
header yalnız allowlisted issuer health URL'ine, redirect kapalı olarak gönderilir; evidence,
ABI, ArcScan ve RPC istekleri header'ı almaz, hata/rapor çıktıları credential'ı içermez.
Candidate hosttaki `/`, statik asset, `/status`, issuer/API ve `/evidence/**` dahil bütün
ingress Basic Auth arkasındadır. Anonymous istek `401 + Basic challenge + no-store` alır;
başarılı auth sonrasında `Authorization` downstream'e taşınmaz. Verifier candidate
credential'ını evidence fetch'ine göndermediğinden public canonical evidence publication'ı
bu sınırı bypass etmeden önce tamamlanmış olmalıdır.

Public-live target'ın henüz deploy edilmemiş exact digest'i kendi health cevabını üretemez.
Bu ikinci self-reference yalnız explicit
`PROMOTION_AUTHENTICATED_CANDIDATE_SOURCE=true` prosedürüyle çözülür. Verifier target
`productLive:true` manifesti için önce aynı issuer health URL'inin credential olmadan
`401 + Basic challenge` verdiğini, sonra doğru operator Basic auth ile preceding candidate
payload'ını döndürdüğünü kanıtlar. Yalnız `productLive:false` ve
`privateCandidateMode:true` faz alanları target'tan farklı olabilir; controller, release,
normalization, signer, policy ve bütün chain/evidence kontrolleri exact target'a bağlıdır.
Signed funded E2E ve operations-drill envelope'ları bu tam verifier run'ında zorunludur.
PASS exact target digest'ine `liveVerified:true` attestation yazar; product-live CI yalnız
bu exact canlı attestation'ı tüketir, non-live bootstrap veya candidate digest'ini reddeder.
Final public-live Next runtime candidate mode/credential'larını taşımaz;
`PRIVATE_CANDIDATE_MODE=false` bile kalıntı sayılır. Explicit source flag veya iki operator
credential eksikse kontrollü farklı-faz doğrulaması fail-closed durur.

Funded/operations run'larından önce tam product-live manifest üretmek, henüz var olmayan
signed-envelope URL/hash çiftlerini uydurmayı gerektirirdi. Bu fixed point placeholder ile
çözülmez. Fully-open candidate'tan ayrı ve bilerek yayımlanamaz intent üretilir:

```bash
pnpm prepare:promotion-target-intent \
  --manifest <active-market-open-candidate.json> \
  --verified-at-block <later-pinned-block> \
  --output <promotion-target-intent.json>
```

`promotionTargetIntent` schema `1.0.0`; exact candidate manifest SHA-256, execution-target
digest, target `verifiedAtBlock` ve future product-live promotion subject'ini taşır. Bir
deployment manifest değildir, canonical/public dosyanın yerine geçemez, product-live build
girdisi olamaz ve `fundedEndToEnd`/`operationsDrill` URL/hash alanları içermez. Intent block'u
candidate block'undan büyük, ilgili run'ın preflight head'inden ileri olamaz. Funded ve
operations runner'ları aynı dosyayı `--target-intent` ile doğrular; değiştirilmiş candidate,
block veya subject fail-closed reddedilir.

Run raporları immutable yayımlandıktan ve bütün ek recovery gate'leri tamamlandıktan sonra
bağımsız reviewer
`pnpm sign:promotion-pass <active-candidate.json> <target-intent.json> <artifact>
<run-report.json> <immutable-report-url> <output.json>` ile aynı candidate + intent
subject/block'una bağlı envelope'ları imzalar. Ancak bu envelope'ların gerçek immutable
URL/hash çiftleri alındıktan
sonra `pnpm stage:release --phase product-live ...` tam manifest üretir. Final manifestin
`promotionExecutionTargetSha256` ve `promotionSubjectSha256` değerleri intent ile exact
eşleşmelidir; placeholder veya tahmini hash yasaktır. Full promotion verifier yine structurally
complete final manifesti ve iki signed envelope'u zorunlu tutar.

Eksik/yarım broadcast canonical manifesti değiştirmez. Aynı release ID ile resume ancak
başarılı receipt'ler ve nonce'lar karşılaştırıldıktan sonra yapılır. Constructor veya
policy değiştiyse yeni release ID ve temiz deployment gerekir; eski adreslerin yeni
suite'e karıştırılması yasaktır.

## Evidence index sözleşmesi

Her yayımlanan release tek bir immutable `index.json` taşır. Index de SHA-256 ile
pinlenir ve en az şu şekle uyar:

```json
{
  "schemaVersion": "1.0.0",
  "chainId": 5042002,
  "releaseId": "<bytes32>",
  "manifestSha256": "<bytes32>",
  "generatedAt": "<RFC3339>",
  "commit": "<git-sha>",
  "artifacts": [
    {
      "artifactId": "deploymentReceipts",
      "schema": "contour/deployment-receipts@1",
      "url": "https://<allowlisted-host>/<immutable-path>",
      "sha256": "<bytes32>",
      "mediaType": "application/json",
      "chainId": 5042002,
      "releaseId": "<bytes32>",
      "blockNumber": 1,
      "createdAt": "<RFC3339>"
    }
  ]
}
```

`artifactId` benzersizdir; URL mutable alias (`latest`, branch head, overwrite edilebilir
object key) kullanamaz. Her JSON artefakt `schemaVersion`, `chainId`, `releaseId`, ilgili
block/tx/address alanları, üretim komutu, commit ve sonuç checksum'unu taşır. Index,
artefakt içeriğinin yerini tutmaz ve hash zincirinin trust root'u değildir; CI exact
manifest digest'i ile bağımsız hostname/runtime/reviewer allowlist'lerini pinler.

## Manifest artefaktları

`verified` state için aşağıdaki altı non-live alanın her biri gerçek URL/hash çifti
olmalıdır:

- `deploymentReceipts`: yedi direct creation receipt'i ve creation block'ları;
- `constructorWiring`: constructor argümanları ile registry/registrar/controller/resolver
  bağlantıları;
- `governanceRoles`: tek funded EOA'nın deployer/owner/treasury/permit-signer parity'si,
  boş `pendingOwner` snapshot'ı ve ownership transaction'ları;
- `treasuryControls`: controller/market owner, liability/surplus ve pause policy snapshot'ı;
- `signerPolicy`: aynı EOA'nın server-only secret custody'si, stateless challenge,
  policy version ve compromise halinde pause/rotation/clean-redeploy modeli;
- `releaseAttestation`: exact manifest digest'i ve verification sonucunu bağlayan rapor.

Her kontrat ayrıca ABI URL/hash çifti ve ArcScan source-verification URL/hash çifti taşır.
ArcScan API source verification tamamlanmıştır; API endpoint biçimi
`https://testnet.arcscan.app/api/v2/smart-contracts/{address}`'tir. Canonical manifestte
yedi rolün `sourceVerified` alanı `true` ve ABI/source URL+hash çiftleri doludur; current
URL/hash index'i public cevapların exact byte hash'lerini kaydeder. Retired
`contour-v1/arcscan/` gövdeleri current cevap snapshot'ı değildir. Endpoint cevabı değişirse promotion
verifier hash uyuşmazlığıyla fail-closed durur; yeni içerik ancak yeniden review edilip yeni
checksum kaydedilerek kabul edilir. Verifier ayrıca `is_verified`, creation durumu, contract
kimliği, compiler/optimizer/EVM ayarları, constructor argümanları ve deployed-bytecode
hash'ini semantik olarak denetler. Bu kaynak kanıtı bağımsız runtime trust root'larının veya altı activation artefaktının
yerine geçmez. Yalnız explorer adres sayfasının varlığı source verification değildir.

`fundedEndToEnd` ve `operationsDrill` yalnız public-live intent'inde zorunludur. Bu iki
JSON generic rapor değil; `promotionSubjectSha256`, `verifiedAtBlock`, `evidenceBlock`,
immutable `runReportUrl`/`runReportSha256`, bağımsız reviewer adresi ve 65-byte imza taşıyan
exact signed `PASS` envelope'udur. Detaylı browser/USDC/incident run raporu imzanın doğrudan
parçasıdır; verifier raporu yeniden fetch/hash eder, zorunlu işlem ve assertion kapsamını
kontrol eder ve her işlem receipt'inin başarı/block/from/to bağını Arc RPC'den yeniden okur.
Private key, challenge secret, wallet signature ve permit signature raporda bulunamaz.

Funded detailed run raporu `schemaVersion: "1.0.0"`, `artifact: "fundedEndToEnd"`,
`verdict: "PASS"` kullanır. Operations broadcast da schema `1.0.0`,
`artifact: "operationsDrill"`, `verdict: "PASS"` raporunu yalnız dört canonical
pause/unpause receipt'i ile readiness kapanma/geri gelme assertion'ları başarıyla
doğrulandığında üretir. Rapor exact transaction setini, promotion subject'i ve evidence
block'u bağlar; hata halinde execution surface'ler fail-safe olarak yeniden pause edilir.

Operations runner PASS'i canonical pause/unpause ve readiness recovery kapsamındadır.
24 saatlik throwaway signer activation/rotation/revoke, clean-redeploy ve
encrypted/offline key-recovery evidence'i mevcut değildir. Bunlar immutable ve bağımsız
review'dan geçene kadar operations reviewer envelope'u oluşturulmaz; G90/G99 `BLOCKED` kalır.

## Immutable public URL ve fetch kuralları

- URL credential/query secret/fragment içeremez ve `https:` olmalıdır.
- Host operator tarafından açıkça allowlist edilir; DNS yalnız public adreslere
  çözülmelidir. Loopback, private, link-local ve metadata hedefleri reddedilir.
- Redirect kabul edilmez. Response timeout ve streaming body cap altında okunur.
- Manifestte URL ile `0x` önekli 32-byte SHA-256 birlikte bulunur; biri eksikse ikisi de
  geçersizdir.
- Aynı URL'nin içeriği değişirse release kanıtı bozulmuş sayılır. Yeni object path ve
  checksum gerekir; geçmiş artefakt silinmez.
- CI, manifestteki runtime hash'leri trust root saymaz. Yedi role-keyed runtime hash'i
  ayrı, review edilmiş allowlist'ten gelir.

## Tek EOA authority kanıtı

Yeni Arc Testnet release'i aynı funded EOA'yı deployer, protocol owner, treasury ve permit
signer olarak kullanır. Kanıt paketi EOA adresini, funding snapshot'ını, yedi temiz deployment
receipt'ini, registry root/reverse-root authority'sini, registrar/controller/marketplace
`owner` ve sıfır `pendingOwner` state'ini, controller/marketplace `treasury` alanlarını ve
controller `permitSigner` değerini aynı evidence block'ta gösterir.

Target release ID
`0x66aeb7b208fdfb6eb9f728a3d0b12d6d3b7132eb0e363b38f7c388c358edefdc`, exact EOA
`0x78de409a6306550882328E2a67160471368387FF`'dir.

Multisig creation receipt'i, Safe proxy/implementation hash'i, owner listesi, threshold,
module/guard/fallback kontrolü veya Safe keystore parolası aranmaz. Aynı EOA'nın permit
signer olması açıkça kabul edilir. Bu sade model server secret compromise'ının tam admin/
treasury compromise'ına dönüşebileceği ve key kaybında in-place recovery bulunmayabileceği
riskini taşır. `operationsDrill` yalnız pause/readiness sonucunu yazar; signer
rotation/revoke, clean-redeploy ve encrypted/offline recovery ayrı immutable evidence
gerektirir. Bu ayrı evidence bugün yoktur ve ilgili gate `BLOCKED` kalır.

Önceki `0xF7c92493f58bBddb1Eb7B8f67AA55e5789a4FB68` Safe-owned suite yalnız retired tarihsel
evidence'dır. Threshold imzaları olmadan tek EOA'ya geçirilemez ve yeni release'in role
evidence'ına dâhil edilemez. Eski ve yeni suite adresleri aynı manifest/evidence index'inde
karıştırılamaz.

## Reviewer ve trust-root ayrımı

- Deployment yapan hesap kendi başına public-live reviewer olamaz.
- Reviewer adresleri manifestte tutulmaz; CI secret/policy deposundaki bağımsız
  allowlist'ten gelir.
- Reviewer imzası chain ID, release ID, promotion-subject digest, verdict ve block'lara
  bağlanır. Kopyalanmış başka-release imzası reddedilir.
- Runtime hash allowlist değişiklikleri code review gerektirir; manifest PR'ıyla
  aynı kişinin tek başına değiştirmesi release onayı sayılmaz.
- Issuer readiness server signer adresini local recovery, canonical manifest ve on-chain
  state ile eşleştirir; browser env veya evidence bundle challenge HMAC/private key taşımaz.

## Fail-closed V2 promotion ve aktivasyon sırası

Bu sıra V2 production geçişinin güncel release-engineering prosedürüdür. Final public
uygulama passwordless kalır; yalnız alias almayan private candidate geçici Basic Auth
sınırındadır. Promotion verifier receipt, runtime, ABI, source, wiring, controller history, tek EOA
owner/treasury/signer policy ve issuer readiness kontrollerinden biri başarısızsa state
ilerlemez. Doğru sıra:

1. retired Safe-owned suite'i yalnız tarihsel olarak koru; yeni release ID ve tek funded
   EOA ile yedi kontratı temiz deploy edip `configured + paused` kanıtını üret;
2. tamamlanmış ArcScan source/ABI snapshot'larını ve diğer evidence'i hâlâ public canonical
   V1/evidence-only hostta immutable URL/hash çiftleriyle yayınla; bağımsız trust root'larla
   `verified` gate'ini geçir;
3. stateless challenge HMAC tamper/expiry/replay, deterministic permit ID, signer secret
   injection/recovery, concurrent on-chain race ve pause/rotation/redeploy testlerini issuance
   olmadan private ortamda tamamla;
4. `active + productLive:false + permitIssuer.active:true` candidate manifestini public
   canonical alias'a geçirmeden stage et; issuer/web'i exact staged digest ve
   `PRIVATE_CANDIDATE_MODE=true` ile production target'a `--skip-domain` kullanarak başlat.
   Bütün candidate ingress Basic Auth arkasındadır. Pause nedeniyle readiness `503` ve
   issuance kapalı kalmalıdır;
5. önce yalnız retained V1 registration'ı pause et; exact cutover block'ta V1 runtime,
   inventory/listing/liability ve V1 marketplace `paused:false` policy'sini immutable
   legacy reference ile yeniden doğrula;
6. tek owner EOA işlemiyle kontrollü V2 controller unpause yap, hemen on-chain state ile
   issuer readiness parity'sini doğrula; private funded registration sonrası V2
   marketplace'i ayrı unpause et;
7. staged manifest promotion doğrulamasından geçince alias almayan private candidate
   deployment'ında `active + productLive:false` acceptance'ı sürdür; public canonical host
   V1/evidence-only deployment'ta kalır;
8. bağımsız signed `PASS` artefaktları ve operations drill sonrası candidate
   credential'larını temizle, exact
   `PRODUCT_LIVE_RELEASE=<releaseId>:<manifestSha256>:<verifiedAtBlock>` ile ayrı
   public-live build/deployment üret ve canonical alias'ı ona taşı. Candidate artifact'i
   promote etme; `PRIVATE_CANDIDATE_MODE=false` dahil hiçbir candidate environment anahtarı
   bırakma.

Production-scope environment/deployment komutlarının normatif sırası
[`DEPLOYMENT.md`](DEPLOYMENT.md)'de verilmiştir: private candidate
`pnpm sync:vercel-release-env -- --mode private-candidate` ardından
`npx vercel@50.28.0 deploy --prod --skip-domain --yes`; final ise
`pnpm sync:vercel-release-env -- --mode public-live --binding <releaseId:manifestSha256:verifiedAtBlock>`
ardından ayrı `npx vercel@50.28.0 deploy --prod --yes` build/deployment'ıdır.

Unpause başarılı fakat servis/manifest promotion başarısızsa tekrar pause edilir; partial
public state “yakında live” diye yayımlanmaz. Issuer önce fail-closed bırakılır, ardından
controller ve marketplace pause durumu doğrulanır. Rollback, isim sahipliği veya başarılı
registration'ı geri almaya çalışmaz; yeni issuance/listing execution'ını durdurur ve
receipt/proceeds reconciliation yollarını açık tutar.

## Mevcut release için eksik kanıtlar

18 Temmuz 2026 itibarıyla raw Foundry receipt, canonical `active` manifest, core immutable
activation URL/hash çiftleri ve yeni tek-EOA release'in yedi kontratı için ArcScan source
verification + ABI cevap hash'leri mevcuttur. Yeni release 15/15 successful clean deployment
ile oluşturulmuş, source/constructor doğrulaması 7/7 geçmiş; controller/marketplace unpaused,
issuer ve public web/API/MCP operasyoneldir. Buna karşılık 24 saatlik signer rotation/revoke,
clean-redeploy ve offline key-recovery evidence'i henüz yoktur. BENS sync/parity ve hosted
ArcScan aktivasyonu da yoktur.
Bu nedenle canonical release operasyonel `active` olarak belgelenebilir fakat
`productLive:false` kaldığı sürece “product-live” veya “evidence-complete” denemez. BENS ve
x402 kendi false capability flag'leri nedeniyle inactive kalır.

Kabul gate'leri ve PASS metadata'sı
[`ACCEPTANCE_MATRIX.md`](ACCEPTANCE_MATRIX.md), operasyon sırası ise
[`OPERATIONS_RUNBOOK.md`](OPERATIONS_RUNBOOK.md) ile birlikte uygulanır.
