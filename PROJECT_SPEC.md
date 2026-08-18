# Contour Name Protocol — Bağlayıcı Ürün Spec'i

> Sürüm: draft `0.1`  
> Kanıt tarihi: 18 Temmuz 2026
> Hedef ağ: yalnız Arc Testnet (`5042002`)  
> Deployment durumu: canonical manifest **`active`** durumundadır; controller ve marketplace
> unpaused, stateless permit issuer active ve public web/API/MCP yüzeyleri açıktır.
> `activationEvidence.productLive` hâlâ `false`; funded E2E ve operations-drill artefaktları
> eksiktir. BENS ve x402 inactive kalır. Önceki Safe-owned adresler retired tarihsel
> evidence'dır. Bu ayrım, operasyonel Arc Testnet erişimini product-live/evidence-complete
> iddiasıyla karıştırmaz.

Bu belge normatiftir. “MUST/ZORUNLU”, “MUST NOT/YASAK” ve “SHOULD/ÖNERİLEN”
ifadeleri ürünün release davranışını tanımlar. Kod veya başka bir belge bununla
çelişirse release durdurulur; sessizce spec dışı davranış kabul edilmez.

## 1. Kimlik ve kapsam

Ürün adı **Contour Name Protocol**, Arc Testnet'e deploy edilen suffix **`.contour`**'dur.
Trademark, domain ve mevcut namespace çakışma kontrolü henüz PASS artefaktına
bağlanmamıştır; bu eksik product-live/evidence-complete iddiasını bloke eder. Ürün bağımsızdır; Arc/Circle
sponsorluğu veya resmîlik iddia edemez.

İlk release şunları kapsar:

- ENS'e yakın registry, ERC-721 registrar, controller, public resolver, reverse
  registrar ve bounded universal resolver;
- wallet-bound direct registration permit;
- registration ve renewal;
- fixed-price marketplace, pull-payment seller proceeds;
- web, SDK, React ve read/unsigned-plan MCP yüzeyleri;
- self-hosted-first ENS-compatible subgraph ve BENS entegrasyon yolu;
- ERC-8004 kimliğinin opsiyonel, read-only gösterimi.

İlk release şunları kapsamaz:

- başka zincirden isim migration'ı veya cross-chain canonical namespace;
- subdomain satışı, auction, bid veya offer;
- upgradeable proxy, DAO/governance token veya birden çok settlement asset;
- Arc mainnet, fiat değer garantisi veya henüz hazır olmayan privacy özelliklerine
  güvenen kayıt güvenliği;
- direct EIP-3009, aktif x402 paid execution veya BENS'i ownership kaynağı yapmak.

## 2. Arc Testnet profili

| Alan | Normatif değer |
| --- | --- |
| Chain ID | `5042002` |
| Hex chain ID | `0x4CEF52` |
| CAIP-2 | `eip155:5042002` |
| HTTP RPC | `https://rpc.testnet.arc.network` |
| WebSocket | Disabled; HTTPS JSON-RPC only |
| Explorer | `https://testnet.arcscan.app` |
| Faucet | `https://faucet.circle.com` |
| ERC-20 USDC | `0x3600000000000000000000000000000000000000` |
| ERC-20 decimals | `6` |
| Native interface precision | `18` |
| Multicall3 | `0xcA11bde05977b3631167028862bE2a173976CA11` |
| Finality UX | receipt dahil olunca success/failed; confirmation sayacı yok |

Uygulama exact-pinned `viem/chains` `arcTestnet` tanımını kullanmalıdır. Önce
`wallet_switchEthereumChain` denenir; unknown-chain halinde kontrollü
`wallet_addEthereumChain`, ardından tekrar switch yapılır. MetaMask ve Rabby canlı
fixture'ı geçmeden fallback wallet metadata release edilemez. Disconnect aksiyonu
wallet bağlıyken yanlış network durumunda da görünür kalır.

Receipt'in bulunması başarı demek değildir. Success için en az
`receipt.status === 1`, doğru chain/controller ve beklenen event/state kanıtlanır.
Arc deterministic finality nedeniyle “2/12 confirmations” gibi sayaç gösterilmez.

Bu release'in tek operational RPC endpoint'i tablodaki
`https://rpc.testnet.arc.network` HTTPS adresidir; WebSocket transportu kapalıdır ve runtime
fallback host'u yoktur. Normal web/operator HTTP profili process-local 2.100 ms
pacing, yalnız JSON-RPC `-32011` veya HTTP `429` için en fazla üç deneme ve kapalı Viem
nested retry kullanır. Uzun, salt-okunur promotion audit'i aynı host üzerinde 6.000 ms
pacing, en fazla altı rate-limit denemesi ve 18.000 ms cap'li backoff kullanan tek
konservatif istisnadır. Uygun read'ler 25 ms Multicall penceresinde birleşir; web readiness
yalnız eşzamanlı aynı read'i coalesce eder ve tamamlanmış sonucu cache'lemez. Bunlar instance
başına korumadır, global Vercel kotası/WAF veya bağımsız ikinci-provider consensus'u değildir.

Resmî belgelerdeki wallet decimals ve event-stream çelişkileri normatif olarak
[Arc doküman kanıtı](docs/ARC_DOCS_EVIDENCE.md) içindeki precedence ve fixture
kapılarıyla çözülür.

## 3. USDC muhasebe modeli

Arc native USDC ve ERC-20 USDC aynı underlying balance'ın iki arayüzüdür:

```text
native: 18 decimals -> gas, address.balance, msg.value
ERC-20:  6 decimals -> balanceOf, approve, transferFrom
```

Zorunlu kurallar:

1. Bütün fiyat, referral, proceeds ve liability değerleri 6-decimal ERC-20 base
   unit olarak saklanır.
2. `address.balance + balanceOf(address)` yapılmaz; UI iki token göstermez.
3. Protokol ödeme yolları ERC-20 `approve/transferFrom` kullanır.
4. Collection exact-delta kontrolü yapar; beklenen miktardan farklı net giriş
   işlemi revert eder.
5. `sweepUnexpectedNative` veya eşdeğeri yasaktır; native sweep ERC-20
   yükümlülüklerini taşıyabilir.
6. UI “USDC network fee” der; ETH veya gwei göstermez.
7. Indexer system ve ERC-20 event stream'lerini iki ayrı ödeme gibi sayamaz.
8. Blocklist nedeniyle payment revert'i hiçbir permit-consumption, liability veya isim
   state'ini yarım bırakmamalıdır.

## 4. Namespace, normalization ve fiyat

Canonical pipeline:

```text
raw input
  -> yalnız leading/trailing whitespace trim
  -> exact-pinned ENSIP-15 normalization
  -> normalized UTF-8 single label
  -> labelhash -> namehash -> tokenId
  -> permit -> event -> subgraph -> BENS
```

UI, SDK, permit issuer, MCP, contract fixture ve subgraph aynı implementation,
profile hash ve corpus hash'ini kullanır. Başka lowercase, compatibility fold veya
sessiz dönüşüm yapılamaz. Normalize sonuç raw input'tan farklıysa kullanıcıya açıkça
gösterilir ve imzalanan byte dizisi normalize sonuçtur.

Başlangıç profili:

- implementation: `@adraffy/ens-normalize@1.11.1`;
- upstream ENSIP-15 Unicode/spec: `17.0.0`;
- upstream `spec.json` SHA-256:
  `4febc8f5d285cbf80d2320fb0c1777ac25e378eb72910c34ec963d0a4e319c84`;
- canonical corpus SHA-256:
  `d25e274d718f468f1edbded13a5319a404d9e2dff39ded6ecf78ef88ea37cf60`;
- profile SHA-256:
  `0889fdb1d0500090d2c605094dd2bd30510a137778f641aca67d8d2fb491f89c`;
- single label; ASCII `.` ile ENS ayraç eşdeğerleri `。` (U+3002), `．` (U+FF0E)
  ve `｡` (U+FF61), empty input, 64+ UTF-8 byte veya 64+ code point reddedilir.
  Normalization sonrası oluşan nokta da yeniden kontrol edilir; full-name input sessizce
  suffix'ten ayrılmaz.

Fiyat, normalize edilmiş label'ın Unicode code point sayısına uygulanır:

```text
1 code point  -> 5_000_000 base units / year
2 code point  -> 2_500_000 base units / year
3 code point  -> 1_000_000 base units / year
4+ code point ->   500_000 base units / year
```

Price permit'te exact amount olarak bağlanır. Contract bytes uzunluğunu fiyat
uzunluğu diye yeniden yorumlayamaz. Yıl/duration hesabı contract, issuer ve UI'da
aynı sabitle test edilir.

## 5. On-chain topoloji

Suite no-proxy ve kaynak doğrulanabilir yedi kontrattan oluşur. Aşağıdaki adresler canonical
tek-EOA Arc Testnet `active` deployment'ıdır. Adres tablosu tek başına source, runtime,
operasyonel readiness veya product-live kanıtı değildir; güncel policy alanları canonical
manifestten ve doğrudan Arc RPC'den okunur.

| Kontrat | Sorumluluk | Adres |
| --- | --- | --- |
| `ArcNameRegistry` | owner/resolver/TTL source of truth | `0xdD69B92f6fAE6da3825b7d126Fe058e78E7F8482` |
| `ArcBaseRegistrar` | ERC-721, expiry, 90 gün grace, registry sync | `0x0DF136b94f99CAfcC010723b51f8D8EC10A0B907` |
| `ArcRegistrarController` | permit validation, price ve exact USDC collection | `0xFbA7618c929075728b82c69B0B2A8C8d98e4B6A3` |
| `ArcPublicResolver` | addr/text/name/contenthash records | `0x3Ea097FFc2089a5Ae24DF46F18d621D007577f5C` |
| `ArcReverseRegistrar` | `<lowercase-address>.addr.reverse` | `0x5ecE3F5815813668307BdCe1405B5C765E526837` |
| `ArcUniversalResolver` | bounded read aggregation | `0x3FAD66f9F3Ca165118D5b292Fa6036e273718Bf0` |
| `ArcNameMarketplace` | fixed listing/buy/pull proceeds | `0xD63f77a01De40b3964051bA03F4158cceFf1ca46` |

Canonical release ID
`0x66aeb7b208fdfb6eb9f728a3d0b12d6d3b7132eb0e363b38f7c388c358edefdc`, exact EOA
`0x78de409a6306550882328E2a67160471368387FF`'dir. Aynı EOA deployer, registrar/controller/
marketplace owner'ı, controller/marketplace treasury ve permit signer'dır. Multisig,
ikinci owner, threshold veya managed KMS/HSM normatif gereksinim değildir.

Önceki release `0xcb31300e…56bf6` ve Safe authority
`0xF7c92493f58bBddb1Eb7B8f67AA55e5789a4FB68` retired'dır. Gerekli threshold imzaları
olmadan tek EOA'ya devredilemediği için eski suite aktifleştirilmez veya canonical adres
setine karıştırılmaz.

Registry owner/resolver/TTL'nin, registrar NFT ownership/expiry'nin ve controller
registration/renewal'ın tek on-chain doğruluk kaynağıdır. Graph Node/BENS/Blockscout
bu state'i indeksler; karar vermez.

`tokenId == uint256(labelhash(normalizedLabel))` olmalıdır. Controller plaintext
normalized label taşıyan, mevcut Blockscout BNS mapping'iyle uyumlu event üretir:

```solidity
event NameRegistered(
  string name,
  bytes32 indexed label,
  address indexed owner,
  uint256 baseCost,
  uint256 premium,
  uint256 expires
);
```

İlk release'te `premium == 0` olabilir. Grace period `7_776_000` saniyedir;
grace'te yalnız mevcut registrant renewal yapabilir, transfer/yeni register aktif
sayılmaz. Resolver'ın yalnız gerçekten uyguladığı interface'ler manifestte true olur.
Reverse isim ancak forward `addr(name) == account` ise verified primary sayılır.

Başarılı registration ve re-registration tek transaction içinde seçili public
resolver'ın record version'ını ilerletmeli ve registry node TTL'ini `0` yapmalıdır.
Böylece eski lease'in addr/text/name/contenthash/interface kayıtları ve custom TTL'i
yeni registrant'a taşınamaz; resolver initialization veya payment revert ederse reset de
EVM atomicity ile geri alınır.

Marketplace yalnız ACTIVE isimleri listeler. Buy exact expected price/fee guard'ı,
listing invalidation ve pull-payment proceeds kullanır. Pause halinde cancel ve
claim yolları açık kalır; treasury yalnız liabilities üzerindeki surplus'u çekebilir.

## 6. Direct registration permit

Public çıplak `register(label)` yoktur. Controller yalnız wallet-bound veya gelecekte
ayrı feature gate arkasındaki keeper-bound `RegistrationPermit` kabul eder.

Permit şu alanları bağlar:

```text
chainId, controller, releaseId, normalizationProfileHash,
normalizedLabelHash, namehash, requester, recipient, payer,
authorizedExecutor, durationYears, resolverDataHash, referrer,
settlementAsset, expectedAmount, expectedReferralBps,
permitId, nonce, issuedAt, validAfter, validUntil
```

- Default issuer TTL 180 saniyedir. Issuer `validUntil - issuedAt` için hard maximum
  295 saniye uygular; `validAfter` en fazla 5 saniye geriye alındığında controller'ın
  `validUntil - validAfter` hard window'u 300 saniyeyi aşmaz.
- Allowance gerektiğinde approval tamamlandıktan sonra permit üretilir.
- Saat sapması için `validAfter = issuedAt - 5s` uygulanabilir.
- `permitId` on-chain single-use'dur; revert permit'i tüketmiş bırakamaz.
- Aktif web/issuer politikasında `requester == recipient == payer == authorizedExecutor ==
  msg.sender` ZORUNLUDUR ve recipient bağlı wallet'tan otomatik türetilir; üçüncü bir payer'ın
  allowance'ı issuer signer compromise edilse bile bu yol üzerinden çekilemez.
- Payment/state değişiminden önce bütün chain/controller/release/profile/hash,
  executor, payer, recipient, price, availability ve deadline guard'ları çalışır.

Issuer stateless çalışır. Canonical UI, OpenAPI, hosted MCP ve acceptance akışı exact
wallet-bound intent'i doğrudan `/api/registration/prepare` route'una gönderir. Prepare
normalizasyon, origin, chain/controller/release/profile, quote, controller nonce,
availability, pause, signer, policy ve allowance state'ini Arc'tan fresh okur. Direct
permit ID `contour-registration-direct-permit-id/v1` domain'inde request ID, issuance
zamanı, exact request fingerprint, requester ve current controller nonce'undan
deterministik türetilir. EIP-712 permit yalnız bu kontrollerden sonra web/Vercel server
runtime'ındaki canonical EOA signer secret'i ile üretilir; default `validUntil`,
`issuedAt + 180s`'dir. PostgreSQL, durable lease veya KMS/HSM core issuer dependency'si
değildir. Ayrı HMAC + wallet `personal_sign` challenge/permit route'ları yalnız geriye
uyumluluk içindir ve canonical direct akışın parçası değildir.

Stateless issuer exclusive reservation garantisi vermez. Aynı label için eşzamanlı birden
fazla kısa ömürlü permit üretilebilir; başarılı sonucu controller'ın current requester
nonce'u, `usedPermit`, registrar availability, exact quote ve EVM atomicity belirler.
İlk başarılı transaction'dan sonra diğer yarışan transaction revert eder ve ödeme/state
kısmi kalmaz. UI permit'i sahiplik veya sıra garantisi olarak gösteremez; retry öncesi
receipt ve on-chain owner/availability tekrar okunur.

Registration API raw label'ı URL query, analytics veya genel application loguna
yazmaz. Public `/name/[label]` lookup path'i edge access loguna ulaşabileceği için
deployment bu segmenti redact/hash etmeli veya route path logging'ini kapatmalıdır;
uygulama doğrudan raw URL'nin ilk hop'ta loglanmadığını garanti edemez.

Web registration BFF'sindeki compatibility challenge/preflight/verify işleri process-local
ve queue oluşturmayan sekizer admission slotu, canonical direct prepare işi dört slot
kullanır. Dolulukta iş sıraya alınmaz; `503` ve `Retry-After` döner. Dört registration POST
body cap'i 16 KiB'dir. Permit signer private key'i exact 32-byte hex olarak yalnız server
secret store'da bulunur. Compatibility route'u etkinse challenge HMAC secret'i ayrıca en az
32 karakterdir ve canonical encoding/constant-time comparison kullanır. Hiçbiri
`NEXT_PUBLIC_*`, browser bundle, log, response veya evidence'e giremez. Bu instance-local
kontrol global abuse limiti değildir; public ingress ayrıca edge/WAF kapasite ve
wallet/client rate policy uygulamalıdır.

Bu Arc Testnet-only release, kullanıcının sade operasyon tercihi gereği aynı fonlanmış
secp256k1 EOA'yı deployer, owner, treasury ve permit signer olarak kullanabilir. Server her
imzadan sonra EIP-712 recovery'yi canonical manifest ve on-chain `permitSigner` ile
karşılaştırır. Multisig, rol ayrımı veya KMS/HSM zorunlu değildir; ancak controller'ın
gerçek signer replacement yolu iki aşamalıdır ve proposal sonrası 24 saatlik activation
delay uygular, compromised signer ise immediate revoke edilebilir. Rotation/revoke drill'i
canonical signer'ı değiştirmeden throwaway fork/release üzerinde yürütülür. Compromise
halinde issuance derhal durdurulur; EOA hâlâ kontrol edilebiliyorsa controller/marketplace
pause edilir ve policy/release version bump yapılır. EOA kaybedilmiş veya ele geçirilmişse
güvenli in-place recovery garanti edilemez; yeni EOA ve yeni release ID ile temiz redeploy
gerekir.

Bu model issuer sansürü ve liveness bağımlılığını kabul eder; “permissionless
registration” iddiası kullanılamaz. Ayrıntılar
[DIRECT_REGISTRATION_SECURITY.md](docs/DIRECT_REGISTRATION_SECURITY.md) içindedir.

## 7. Read model ve BENS

BENS stratejisi self-host-first'tür:

```text
Arc eventleri -> Graph Node/PostgreSQL/IPFS -> ENS-compatible subgraph
             -> version+digest pinned BENS -> optional Blockscout integration
```

Core permit issuer'ın stateless olması bu katmanı değiştirmez. Graph Node/BENS kendi
ayrı PostgreSQL veritabanı, migration/backup/restore policy'si ve operatör erişimiyle
çalışmalıdır; core issuer secret'ları veya runtime state'iyle paylaşım yapılamaz.

Subgraph exact deployment block'larından başlar; block `0` kullanılmaz. `Domain`,
`Registration`, `Account`, `Resolver` ve event entity'lerinde namehash, normalized
name, labelhash, registry owner, NFT registrant, resolved address, expiry, tokenId
ve 6-decimal registration cost ayrımı korunur.

Manifestteki `protocolConfigured`, `subgraphSynced` ve `hostedArcscanActive` ayrı
operatör iddialarıdır; runtime health probe sonucu değildir. Schema ayrı health/parity
alanları taşıyana kadar BENS/Blockscout health, lag ve pinned-block parity sonuçları
[acceptance artefaktlarında](docs/ACCEPTANCE_MATRIX.md) ayrıca tutulur. ArcScan operator
aktivasyonu kanıtlanmadan hosted search aktif gösterilemez. BENS sonucu ownership veya
verified reverse kararı için yeterli değildir.

## 8. Agent, MCP, EIP-3009 ve x402

MCP yalnız public read, manifest discovery, unsigned transaction plan ve permit
request payload hazırlar. Private key tutamaz, imzalayamaz veya broadcast edemez.

ERC-8004 identity/reputation/validation yalnız opsiyonel display metadata'dır; isim
ownership veya registration prerequisite değildir. Display identity için reverse
sonuç forward-confirm edilmelidir.

Direct EIP-3009 Arc USDC implementation'ında mevcut olsa da release 1'de disabled'dır.
EOA, EIP-1271/smart-wallet fallback, replay, blocklist, proxy upgrade ve exact-delta
fixture'ları tamamlanmadan etkinleştirilemez.

x402 Arc Testnet'i desteklese de release 1'de `active: false` ve fail-closed'dur.
Circle'ın production seller akışı payment settlement'ı service delivery öncesi
önerirken on-chain registration geri alınamaz; spec'teki registration-first akışta
ise payment failure riski vardır. Durable idempotency, funded E2E, açık compensation
/refund mekanizması ve operator runbook kanıtlanmadan paid route açılamaz. Shipped
keeper bir `503` route'u sunmaz: process startup'ta refuse eder ve HTTP listener
mount etmez. Inactive `KeeperWorkflow` registration-first skeleton'ı settlement
failure halinde ücretsiz isim riski taşıdığı için activation implementation'ı değildir.

## 9. UX ve görsel sistem

Ana route'lar `/`, `/name/[label]`, `/me`, `/market`, `/developers` ve public health
özetiyle başlayan `noindex` `/admin`'dir. Derin admin state ve Controls yalnız bağlı
cüzdanın canlı governance/owner/pending-owner yetkisi zincirden doğrulandıktan sonra açılır.
Browser hiçbir admin veya issuer secret'ı almaz; yazmalar connected wallet tarafından
imzalanır. Her işlem canonical runtime hash + release kontrolü, simulation, taze yetki/state
okuması, exact receipt/input/value doğrulaması ve action-specific post-state kontrolü kullanır.
Gönderilmiş fakat doğrulaması tamamlanmamış işlem session recovery kaydı çözülmeden yeni
admin transaction gönderilemez. Arbitrary registry root/subnode recovery ile immutable
price/suffix/grace/settlement/release ve `productLive` değişiklikleri browser yüzeyi dışındadır.
Registration tek primary CTA kullanır; approval gerekiyorsa iki wallet isteğini
önceden açıklar. Permit unavailable ise wallet/payment başlatılmaz ve kullanıcıya:

```text
Registration is temporarily unavailable.
No wallet request or payment was made.
```

mesajı gösterilir.

Görsel sistem “Modular Typography” olmalıdır:

- desktop 12 kolon, mobil 4 kolon; bilgi sırası korunur;
- bütün rotaların ana content shell'i merkezlenir ve `80rem` (`max-w-7xl`) üst sınırını aşmaz;
- 1px separators ve geniş typographic nameplate/market rows;
- büyük tipografi yalnız gerçek name, status, price veya expiry verisi taşır;
- `#000b24`, `#0b223e`, `#326796`, `#4197a1`, `#e2d0aa`, `#f5ecda`,
  `#acc6e9`, `#ffffff`, `#071018` başlangıç paleti;
- gradient, glass, glow, 3D orb, bento dashboard, generic NFT cards ve nested
  borders yasaktır;
- Space Grotesk / DM Sans / IBM Plex Mono;
- reduced-motion, keyboard operation ve WCAG AA zorunludur;
- Arc logosu ürün logosu değildir; v1'de logo yerine text-only “Built for Arc
  Testnet” ve non-affiliation kullanılır.

## 10. Manifest ve aktivasyon

`deployments/5042002.json` tek public deployment truth kaydıdır. Draft state'te
product brand kararı dokümanda sabit olsa bile bütün yedi ürün adresi, tx hash'i,
block, ABI URL/hash ve release ID deployment kanıtı gelene kadar `null` kalabilir.

Yeni Arc Testnet deployment clean deployment'ı 15/15 işlemle tamamlamış, yedi adres ve tek
EOA authority belirlenmiş, ArcScan source/ABI ve constructor eşleşmesi 7/7 doğrulanmış ve
canonical manifestte `active` duruma geçirilmiştir. Controller/marketplace unpaused ve issuer
active'dir. Manifest release ID/adres/receipt/runtime/source URL+hash setini atomik taşır.
`productLive:false`, eksik funded E2E ve operations-drill kanıtını açıkça korur; operasyonel
`active` state'i evidence-complete/product-live iddiası değildir. Önceki Safe-owned suite
retired kalır.

Manifest geçişi atomik olmalıdır:

1. Yedi kontratın address + transactionHash + positive deploymentBlock + runtime code
   hash alanları atomik girilir; hiçbir adres başka bir product contract ile tekrar edemez.
2. ABI, ArcScan source-verification ve activation artefakt URL'leri yalnız SHA-256 ile
   birlikte girilir ve `verified`/`active` state'inde immutable HTTPS olmak zorundadır.
3. `verified` için deployment/source/ABI/wiring/governance/treasury/signer/release kanıtı;
   public-live için ayrıca funded E2E ve operations-drill kanıtı gerekir.
4. Yedi contract runtime hash'i manifestten bağımsız, canonical role-keyed CI trust
   root'uyla eşleşir.
5. Registrar/controller/marketplace `owner`, controller/marketplace `treasury`, registry
   root/reverse-root authority ve on-chain `permitSigner` canonical tek fonlanmış EOA ile
   exact eşleşir; bütün `pendingOwner` değerleri sıfırdır.
6. Registrar `ControllerChanged` geçmişi deployment block'undan latest block'a replay
   edilir: canonical controller dışında hiçbir adres geçmişte dahi enable edilmiş olamaz
   ve final state yalnız canonical controller'ı etkin bırakır.
7. Permit issuer signer/policy, controller/market policy ve normalization/release parity
   canlı contract state'iyle doğrulanır.
8. Controller-open/marketplace-paused private candidate, marketplace açılmadan önce ayrı
   `registrationActivationSmoke` gate'inden geçer. Dry-run `NOT_EXECUTED` planıdır; explicit
   release ID + registrant teyitli broadcast tam iki transaction/on bir assertion ve
   marketplace pause parity'siyle schema `1.0.0` PASS üretir. Bu focused gate daha sonraki
   funded public-live kabulünün yerine geçmez.
9. Funded/operations run'larından önce market-open candidate'tan schema `1.0.0`, bilerek
   yayımlanamaz `promotionTargetIntent` üretilir. Intent exact candidate digest'ini, later
   target block'u, future product-live execution digest'ini ve promotion subject'ini bağlar;
   deployment manifest değildir ve henüz var olmayan artefakt URL/hash placeholder'ı taşımaz.
10. Funded ve operations detailed PASS raporları schema `1.0.0`'dır. Operations broadcast
    dört canonical pause/unpause receipt'ini ve readiness kapanma/geri gelme assertion'larını
    exact promotion target'a bağlayan `operationsDrill/PASS` raporunu doğrudan üretir.
11. Public-live `fundedEndToEnd` ve `operationsDrill` artefaktları, bütün activation
   artifact URL/hash çiftleri boşlanarak hesaplanan non-circular promotion-subject
   digest'ine bağlı signed `PASS` envelope taşır. Reviewer adresi bağımsız CI allowlist'inde
   olmalı; signature, release, chain, evidence/verification block'ları ve immutable ayrıntılı
   run raporunun URL/hash'i doğrulanmalıdır. Verifier rapordaki zorunlu işlem kapsamını ve
   başarı/block/from/to receipt bağlarını Arc RPC'den yeniden okur. Reviewer CLI exact active
   candidate + target intent + run raporunu birlikte tüketir; final manifest yalnız gerçek
   immutable envelope URL/hash çiftleriyle hazırlanır.
12. `draft -> configured -> verified -> active` geçişleri operasyonel capability'yi belirler.
   Public read/register/market; canonical manifest `active`, ilgili on-chain policy unpaused
   ve permit issuer active olduğunda açılabilir. `activationEvidence.productLive` ayrı,
   daha güçlü evidence-complete promotion seviyesidir ve mevcut operasyonel Arc Testnet
   erişiminin önkoşulu değildir.
13. Product-live web ve issuer başlangıcı ayrıca exact
      `PRODUCT_LIVE_RELEASE=<releaseId>:<manifestSha256>:<verifiedAtBlock>` binding'ini
      zorunlu tutar. Private candidate Basic-auth korumalı ingress'te çalışır. Product-live
      build candidate credential'larını reddeder; deployment ingress/WAF policy'si ve
      internal-header spoofing negatifleri zorunludur. Uygulama doğrulanmış client-identity
      header'ı implement etmediğinden client-supplied internal header auth sayılmaz.
14. BENS ve x402 kendi capability flag'leriyle ayrıca aktif edilir; core state bunları
     otomatik aktif saymaz.

Schema yapısal fail-closed kuralları uygular. Ayrı `pnpm verify:promotion` doğrulayıcısı
Arc RPC ve hash-pinned HTTPS artefaktlarından chain/block, doğrudan deployment receipt,
evidence-block ve latest runtime code, yayımlanmış ABI'nin zorunlu surface'i, yedi
contract wiring'i, bağımsız contract hash trust root'larını, tek EOA owner/treasury/signer
parity'sini, boş `pendingOwner` state'ini, controller history'sini, controller/market
policy ve aktif issuer health parity'sini yeniden okur.
Artefakt fetch'i yalnız operator-allowlisted credential-free HTTPS hostname'e gider;
DNS'in yalnız public adreslere çözülmesi, redirect reddi, 10 saniye timeout ve 4 MiB
streaming cap zorunludur; issuer health cap'i 64 KiB'dir. Doğrulayıcı live-only
artefaktlarda reviewer-allowlisted signed `PASS` envelope'u, bağlı run raporu hash'ini ve
zorunlu transaction receipt'lerini doğrular fakat fonlu browser/BENS/operasyon run'ını
kendi başına üretemez; bunlar
[ACCEPTANCE_MATRIX.md](docs/ACCEPTANCE_MATRIX.md) sözleşmesine uygun immutable kanıt
olarak kalır. `productLive:false` bir `active` release'in public Arc Testnet üzerinde
operasyonel olmasına engel değildir; yalnız product-live/evidence-complete iddiasını engeller.

## 11. Release kapıları

Bir release “product-live” veya “evidence-complete” sayılmadan önce:

- trademark/domain/suffix collision kontrolü tamamlanmış;
- Arc chain, wallet metadata ve dual USDC event canlı fixture'ları geçmiş;
- contract, stateless direct permit, normalization, shared-USDC, resolver/reverse ve
  marketplace invariant testleri geçmiş; compatibility challenge route'u etkinse onun
  HMAC/wallet-recovery testleri de geçmiş;
- yedi kontrat deploy + source verify + manifest evidence'i tamamlanmış;
- core manifest `active`, `activationEvidence.productLive == true`,
  `permitIssuer.active == true` ve public readiness
  chain/controller/release/profile/signer/policy parity'si başarılı;
- promotion attestation exact manifest digest'ine bağlı ve live-verified; web ile issuer
  aynı exact `PRODUCT_LIVE_RELEASE` değerini kullanıyor; trusted product ingress auth
  kanıtlanmış ve private-candidate credential'ları kaldırılmış;
- funded MetaMask/Rabby desktop/mobile registration/renew/buy E2E geçmiş;
- owner/signer secret injection/recovery, direct intent/permit tamper/expiry, EOA
  compromise/rotation/redeploy ve pause drill'i yapılmış; compatibility challenge route'u
  etkinse onun HMAC tamper/expiry testleri de yapılmış;
- raw-label leakage taraması ve security review tamamlanmış;
- self-hosted BENS iddia ediliyorsa exact-block replay, sync, lookup ve parity testleri
  geçmiş;
- pause ve incident runbook'ları denenmiş;
- `x402.active == false`, `EIP3009_ENABLED == false`; ERC-8004 failure core flow'u
  bozmuyor

olmalıdır. Ayrıntılı kanıt durumu [ACCEPTANCE_MATRIX.md](docs/ACCEPTANCE_MATRIX.md)
ile tutulur. Kanıtsız bileşen “complete”, “verified”, “hosted” veya “live” diye
belgelenemez. Core state semantiği gelecekte değişse bile Release 1 direct-registration
ürünü active issuer olmadan ürün-live değildir.

## 12. Birincil kaynaklar

- [Arc Testnet bağlantı bilgileri](https://docs.arc.io/arc/references/connect-to-arc)
- [Arc stablecoin-native modeli](https://docs.arc.io/arc/concepts/stablecoin-native-model)
- [Arc transaction lifecycle](https://docs.arc.io/integrate/wallets/transaction-lifecycle)
- [Arc USDC system event'leri](https://docs.arc.io/arc/references/usdc-system-events)
- [ENSIP-15](https://docs.ens.domains/ensip/15/)
- [ENS name processing](https://docs.ens.domains/resolution/names/)
- [Blockscout BENS entegrasyonu](https://docs.blockscout.com/setup/microservices/blockscout-ens-bens-name-service-integration)
- [Circle Gateway x402 seller quickstart](https://developers.circle.com/gateway/nanopayments/quickstarts/seller)
- [Arc ERC-8004 tutorial](https://docs.arc.io/arc/tutorials/register-your-first-ai-agent)

Kaynak yorumları ve çelişki çözüm politikası
[ARC_DOCS_EVIDENCE.md](docs/ARC_DOCS_EVIDENCE.md) içindedir.
