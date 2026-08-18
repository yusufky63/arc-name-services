# Arc ve Entegrasyon Doküman Kanıtı

> Araştırma tarihi: **16 Temmuz 2026**.  
> Yalnız Arc/Circle/ENS/Blockscout resmî dokümanları, resmî repository'leri ve ArcScan
> verified contract sayfaları kullanılmıştır. Kaynaklar değişebileceği için her release
> bu kayıt defterini yeniden doğrular.
>
> Deployment durum snapshot'ı: **17 Temmuz 2026** — Yeni canonical tek-EOA Contour suite'i
> Arc Testnet'e deploy edilmiş, manifest `configured`, controller/marketplace pause ve
> product-live kapalıdır. Yeni yedi kontratın ArcScan source/ABI doğrulaması 7/7 tamamlanmış,
> constructor argümanları deployment broadcast'ıyla eşleşmiştir. Public immutable activation
> publication'ı, promotion, issuer readiness ve funded acceptance henüz tamamlanmamıştır.
> Bu paragraf tarihsel aktivasyon-öncesi snapshot'tır. **18 Temmuz 2026 güncel durumu:**
> canonical manifest `active`, controller/marketplace unpaused ve issuer active'dir.
> **20 Temmuz 2026:** secret-redacted raw funded E2E `PASS` üretilmiştir; immutable yayın ve
> bağımsız reviewer envelope'u henüz tamamlanmadığı için `productLive:false` kalır. Operations
> drill/recovery, BENS ve hosted ArcScan kanıtları da eksiktir.

## Kanıt precedence politikası

Belge çelişkilerinde otomatik varsayım yapılmaz. Uygulanan sıra:

1. Konuya özel, güncel resmî reference sayfası;
2. Arc Testnet canlı RPC/receipt/event/code-hash fixture'ı;
3. Genel tutorial veya integration guide;
4. Pinned library chain definition;
5. Üçüncü taraf anlatımı yalnız yardımcı bilgi, release evidence'i değil.

Canlı fixture resmî dokümanla uyuşmazsa feature fail-closed kalır ve upstream issue/
operator doğrulaması istenir. Wallet display metadata hiçbir zaman ekonomik decimal
truth'u belirlemez.

## Doğrulanan Arc ağı

| İddia | Kanıt | Ürün kararı |
| --- | --- | --- |
| Arc Testnet chain ID `5042002` | [Arc chain overview](https://docs.arc.io/arc-chain) | Exact chain guard |
| Proje HTTP RPC `https://rpc.testnet.arc.network` | Live `eth_chainId=5042002` ve canonical manifest | Bu release'in tek operational HTTP endpoint'i; fallback yok |
| WebSocket | Runtime discovery (`/runtime-manifest.json`) ve operasyon konfigürasyonu | Kapalı; bu release yalnız HTTPS JSON-RPC kullanır |
| Arc provider listesi | [RPC endpoints](https://docs.arc.io/arc/references/rpc-endpoints) | Doküman araştırması; listedeki başka hostlar bu release'te runtime fallback değildir |
| Explorer `https://testnet.arcscan.app` | [Connect to Arc](https://docs.arc.io/arc/references/connect-to-arc) | Tx/contract links |
| ~0.48s block + deterministic sub-second finality | [Arc chain overview](https://docs.arc.io/arc-chain) | Receipt inclusion sonrası status; confirmation counter yok |
| Public Testnet deployment model | [Deployment model](https://docs.arc.io/arc/concepts/deployment-model) | Bütün UI testnet olarak etiketlenir |
| Receipt inclusion final, runtime revert mümkün | [Transaction lifecycle](https://docs.arc.io/integrate/wallets/transaction-lifecycle) | `status===1` + event/state doğrulama |
| Faucet 20 test USDC / 2 saat / address+chain | [Circle faucet](https://faucet.circle.com) | Test fiyatları 20 USDC altında; ekonomik garanti değil |

İmzalı canonical manifest, immutable chain metadata'sının bir parçası olarak non-runtime
`websocketUrl` alanını koruyabilir. Runtime discovery bu alanı bilinçli olarak yayımlamaz;
web, operator, MCP ve SDK runtime transportları yalnız canonical HTTPS RPC'yi kullanır.

CAIP-2 `eip155:5042002`, EIP-155 chain ID'den türetilir ve Circle x402 Arc örneğinde
de kullanılır.

Normal web/operator HTTP politikası aynı process içinde 2.100 ms pacing ve yalnız
JSON-RPC `-32011`/HTTP `429` için en fazla üç denemedir. Uzun, salt-okunur promotion
verification aynı canonical host üzerinde 6.000 ms pacing, en fazla altı rate-limit denemesi
ve 18.000 ms cap'li backoff kullanır. Uygun read'ler 25 ms Multicall penceresinde
birleştirilir. Bu client-side korumalar bağımsız ikinci-provider observation veya Vercel
instance'ları arasında global rate limit değildir; yanlış chain, stale/belirsiz head veya
receipt/state uyuşmazlığında write işlemi durur.

## Arc sistem adresleri

Bu tablo Contour deployment'ı değildir. Arc/Circle'ın resmî sistem kontratlarını
listeler.

| Bileşen | Adres | Kaynak |
| --- | --- | --- |
| ERC-20 USDC | `0x3600000000000000000000000000000000000000` | [Arc contract addresses](https://docs.arc.io/arc/references/contract-addresses) |
| USDC system emitter | `0xfffffffffffffffffffffffffffffffffffffffe` | [USDC system events](https://docs.arc.io/arc/references/usdc-system-events) |
| GatewayWallet | `0x0077777d7EBA4688BDeF3E311b846F25870A19B9` | [Arc contract addresses](https://docs.arc.io/arc/references/contract-addresses) |
| GatewayMinter | `0x0022222ABE238Cc2C7Bb1f21003F0a260052475B` | [Arc contract addresses](https://docs.arc.io/arc/references/contract-addresses) |
| Multicall3 | `0xcA11bde05977b3631167028862bE2a173976CA11` | [Arc contract addresses](https://docs.arc.io/arc/references/contract-addresses) |
| Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` | [Arc contract addresses](https://docs.arc.io/arc/references/contract-addresses) |

Contour canonical tek-EOA suite'i (adresler güncel; `configured / paused` etiketi aşağıdaki
17 Temmuz tarihsel snapshot'ına aittir):

| Registry | Base | Controller | Resolver | Reverse | Universal | Marketplace |
| --- | --- | --- | --- | --- | --- | --- |
| `0xdD69B92f6fAE6da3825b7d126Fe058e78E7F8482` | `0x0DF136b94f99CAfcC010723b51f8D8EC10A0B907` | `0xFbA7618c929075728b82c69B0B2A8C8d98e4B6A3` | `0x3Ea097FFc2089a5Ae24DF46F18d621D007577f5C` | `0x5ecE3F5815813668307BdCe1405B5C765E526837` | `0x3FAD66f9F3Ca165118D5b292Fa6036e273718Bf0` | `0xD63f77a01De40b3964051bA03F4158cceFf1ca46` |

Clean deployment 15/15 successful transaction ile tamamlanmıştır. Canonical release ID
`0x66aeb7b208fdfb6eb9f728a3d0b12d6d3b7132eb0e363b38f7c388c358edefdc`, exact
deployer/owner/treasury/permit-signer EOA
`0x78de409a6306550882328E2a67160471368387FF`'dir. 17 Temmuz snapshot'ında controller ve
marketplace paused'dı; güncel canonical manifestte ikisi de unpaused'dır.

Contour retired historical suite'i:

| Registry | Base | Controller | Resolver | Reverse | Universal | Marketplace |
| --- | --- | --- | --- | --- | --- | --- |
| `0xE1d5A977A3e73f64C1A64cFebCc6E206D259e3ff` | `0x6C47Bf685914cf7469939bE255FE21702Cb0eBd7` | `0x3cFB9b49359C338E22Ee7C7520080C5c0D494911` | `0x8B007f3755e18202944C8FbF09fCE6005492881F` | `0xEb5D81D7a90cEf350245974E6ADC8502A2c241de` | `0x3E8d895b1F026F989dceE868B5079DF9eB17f33e` | `0x4e37a666Ca60aFF7E47d1C962D1B69a720a0846b` |

Retired release ID
`0xcb31300ed4857f0ffdb9c3c613818182ea920d1547c58d3beb8cfdb821056bf6`,
authority ise `0xF7c92493f58bBddb1Eb7B8f67AA55e5789a4FB68` 2-of-3 Safe'idir. Threshold
imzaları olmadan tek EOA'ya geçirilemeyeceği için bu suite superseded'dır ve activation
adayı değildir.

BENS ve x402 kapalıdır.

Source verification endpoint biçimi:

```text
https://testnet.arcscan.app/api/v2/smart-contracts/{address}
```

Yeni suite'in yedi API cevabı
`deployments/evidence/5042002/contour-v1/arcscan-source-verification.json` içinde URL,
verification zamanı ve exact response SHA-256 ile pinlenir. Eski
`deployments/evidence/5042002/contour-v1/arcscan/` dosyaları retired Safe suite'e aittir ve
güncel index tarafından referans edilmez. Canonical `active` manifest güncel API URL/hash
çiftlerini, immutable core activation artefaktlarını ve positive `verifiedAtBlock` değerini
taşır. Funded E2E, operations drill ve bağımsız promotion trust root'ları yalnız
product-live/evidence-complete gate'i için eksik kalır.

| Rol | ArcScan source/ABI API | Sonuç |
| --- | --- | --- |
| Registry | [`0xdD69…F8482`](https://testnet.arcscan.app/api/v2/smart-contracts/0xdd69b92f6fae6da3825b7d126fe058e78e7f8482) | `is_verified:true`, ABI/constructor eşleşiyor |
| Base registrar | [`0x0DF1…B907`](https://testnet.arcscan.app/api/v2/smart-contracts/0x0df136b94f99cafcc010723b51f8d8ec10a0b907) | `is_verified:true`, ABI/constructor eşleşiyor |
| Controller | [`0xFbA7…B6A3`](https://testnet.arcscan.app/api/v2/smart-contracts/0xfba7618c929075728b82c69b0b2a8c8d98e4b6a3) | `is_verified:true`, ABI/constructor eşleşiyor |
| Public resolver | [`0x3Ea0…7f5C`](https://testnet.arcscan.app/api/v2/smart-contracts/0x3ea097ffc2089a5ae24df46f18d621d007577f5c) | `is_verified:true`, ABI/constructor eşleşiyor |
| Reverse registrar | [`0x5ecE…6837`](https://testnet.arcscan.app/api/v2/smart-contracts/0x5ece3f5815813668307bdce1405b5c765e526837) | `is_verified:true`, ABI/constructor eşleşiyor |
| Universal resolver | [`0x3FAD…8Bf0`](https://testnet.arcscan.app/api/v2/smart-contracts/0x3fad66f9f3ca165118d5b292fa6036e273718bf0) | `is_verified:true`, ABI/constructor eşleşiyor |
| Marketplace | [`0xD63f…ca46`](https://testnet.arcscan.app/api/v2/smart-contracts/0xd63f77a01de40b3964051ba03f4158cceff1ca46) | `is_verified:true`, ABI/constructor eşleşiyor |

Manifest parser'ı configured address için stored deployment tx + positive block'u;
`verified`/`active` için ayrıca runtime code hash, `sourceVerified`, hash-pinned
ABI/ArcScan source evidence ve activation artefaktlarını ister. Ayrı
`pnpm verify:promotion` komutu receipt'i, evidence/latest block runtime code'u, ABI
surface'ini, wiring/role/treasury/policy state'ini, registrar controller history'sini ve
issuer readiness parity'sini canlı doğrular. Manifestteki değerler tek başına trust root
değildir: yedi role-keyed contract runtime hash'i bağımsız CI allowlist'iyle eşleşmeli;
registrar/controller/marketplace owner, controller/marketplace treasury ve controller
permit signer exact canonical funded EOA olmalı, `pendingOwner` sıfır olmalıdır. Artefakt
fetch'i HTTPS hostname allowlist + public DNS,
redirect/timeout/streaming cap sınırlarıyla yapılır.

Public-live funded E2E ve operations drill kanıtları, artifact URL/hash çiftleri
blank edilerek hesaplanan non-circular promotion-subject digest'ine bağlı signed `PASS`
envelope taşır ve reviewer bağımsız allowlist'ten gelir. Envelope immutable ayrıntılı run
raporunun URL/hash çiftini de bağlar; doğrulayıcı raporu yeniden fetch/hash edip zorunlu
işlem receipt'lerini Arc RPC'den doğrular. Gerçek run üretimi ayrı
[acceptance sözleşmesine](ACCEPTANCE_MATRIX.md) tabidir.
`PRODUCT_LIVE_RELEASE=<releaseId>:<manifestSha256>:<verifiedAtBlock>` exact binding'i,
trusted product ingress ve `productLive: true` olmadan ürün dokümanında “live” denemez.
Receipt'in korunması, immutable URL/hash çiftleri, evidence index'i ve reviewer trust-root
ayrımı [`EVIDENCE_POLICY.md`](EVIDENCE_POLICY.md) ile tanımlanır. Mevcut yerel Foundry
receipt'i deployment çalışmasının kaydıdır; ArcScan source verification kanıtı ayrı API
snapshot'larıdır. İkisi de tek başına promotion PASS sonucu değildir.

## USDC shared-balance kanıtı

[Stablecoin-native model](https://docs.arc.io/arc/concepts/stablecoin-native-model)
şunları tanımlar:

- native interface 18-decimal precision kullanır;
- ERC-20 USDC interface 6 decimals kullanır;
- ikisi aynı underlying balance'ı temsil eder;
- dApp integrations için ERC-20 interface tercih edilir;
- `balanceOf` 6 decimal altındaki native dust'ı göstermeyebilir.

Ürün sonucu:

- tek USDC asset ve tek balance row;
- bütün fiyat/liability 6-decimal ERC-20 base unit;
- gas ayrı “USDC network fee”;
- native sweep yok;
- native + ERC-20 balance toplama yok;
- live exact-delta/shared-balance fixture release gate.

## Resmî doküman çelişkisi 1 — wallet decimals

### Çelişen kaynaklar

[How to add Arc to your wallet](https://docs.arc.io/integrate/wallets) EIP-3085
örneğinde `nativeCurrency.decimals: 6` kullanır ve bunu display için açıklar. Aynı
sayfadaki balance/native precision açıklamaları 18-decimal davranışla birlikte
okunmalıdır.

[Custody integration](https://docs.arc.io/integrate/exchanges/custody) native
precision'ı 18, kullanıcı display'ini 6 olarak ayırır ve örnek chain metadata'sında
18 kullanır. [Stablecoin-native model](https://docs.arc.io/arc/concepts/stablecoin-native-model)
de native 18 / ERC-20 6 ayrımını tanımlar.

### Resolution

1. Economic accounting ve amount parsing yalnız ERC-20 6 decimals'tır.
2. Native balance/fee execution precision 18 olarak ele alınır.
3. Uygulama exact-pinned `viem/chains` `arcTestnet` tanımını kullanır.
4. Manual EIP-3085 fallback tek docs satırından türetilmez; MetaMask ve Rabby'de
   canlı `add -> switch -> balance -> fee -> send` fixture'ıyla pinlenir.
5. Provider metadata accounting truth olarak kullanılmaz.
6. Fixture tamamlanana kadar custom wallet-add fallback release blocker'dır.

Bu karar docs çelişkisini saklamaz; UI display, native execution precision ve ERC-20
accounting'i ayrı kavramlar olarak tutar.

## Resmî doküman çelişkisi 2 — USDC event stream'leri

### Konuya özel kaynak

[USDC system events](https://docs.arc.io/arc/references/usdc-system-events) iki stream
tanımlar:

- system emitter `0xfffffffffffffffffffffffffffffffffffffffe`, EIP-7708 tarzı
  `Transfer`, 18 decimals ve bütün native/USDC hareketleri;
- ERC-20 contract `0x3600...0000`, 6 decimals ve ERC-20 interface transferleri;
- ERC-20 transferi iki stream'i de üretebilir;
- native transfer yalnız system stream'de görünür;
- eski pre-Zero5 event'leri legacy emitter'dan gelebilir.

### Çelişen genel sayfalar

[Indexing events](https://docs.arc.io/integrate/infrastructure/indexing-events) ve
[Exchange deposits](https://docs.arc.io/integrate/exchanges/deposits) gibi genel
entegrasyon sayfaları hareketleri tek 6-decimal USDC `Transfer` stream'i/USDC contract
event'i gibi özetleyebilen ifadeler içerir. Bu, dedicated system-event referansındaki
dual-emitter davranışıyla aynı model değildir.

### Resolution

Dedicated event reference precedence alır, fakat production logic yalnız belgeye
göre açılmaz. Release fixture'ı:

1. aynı wallet'lar arasında ERC-20 `transfer` yapar;
2. receipt'in iki emitter/log değerini ve 18↔6 scaling'ini kaydeder;
3. native `eth_sendTransaction` USDC gönderimini kaydeder;
4. indexer'ın her ekonomik hareketi bir kez saydığını kanıtlar;
5. legacy/pre-upgrade range policy'sini start block'a göre test eder.

Event identity tx hash + log index + emitter ile saklanır; cross-stream business
dedupe ayrı deterministic key/policy kullanır. Fixture uyuşmazsa indexer active olamaz.

## Resmî entegrasyon çelişkisi 3 — x402 settlement sırası

### Circle önerisi

[x402 seller quickstart](https://developers.circle.com/gateway/nanopayments/quickstarts/seller)
production seller için ayrı verify-then-settle yerine doğrudan settlement çağrısını,
middleware'in resource/service'i vermeden önce payment'ı settle etmesini önerir. Aynı
akış payment `validBefore` penceresini en az yedi gün + buffer olacak şekilde örnekler.

[x402 concept](https://developers.circle.com/gateway/nanopayments/concepts/x402) ve
[batched settlement](https://developers.circle.com/gateway/nanopayments/concepts/batched-settlement)
Gateway deposit balance ve batch settlement modelini açıklar.

### Contour ile çelişki

Registration geri alınamaz on-chain service'tir. Blueprint'in planladığı
`registration_confirmed -> payment_settled` sırası payment failure halinde ücretsiz
isim riski taşır. Circle'ın `settle -> deliver` önerisi ise registration revert
ettiğinde ödeme alınmış fakat isim verilmemiş durum üretir. İki sistem arasında atomik
transaction yoktur; resmî belgelerde Contour'a uygulanabilir hazır refund endpoint'i
kanıtı bulunmamıştır.

### Resolution

- Release 1: `X402_ENABLED=false`, manifest `active=false`; keeper startup sırasında
  çıkar ve hiçbir HTTP/paid route mount etmez. `X402_ENABLED=true` tek başına da
  eksik managed adapter gate'ini aşamaz.
- Direct permit TTL 180 saniye kalır; x402'nin ≥7 günlük authorization penceresiyle
  eşitlenmez.
- Activation için settlement-first + funded automatic compensation veya açıkça
  kabul edilmiş registration-first seller credit risk modelinden biri seçilmelidir.
- Mevcut inactive `KeeperWorkflow` registration-first skeleton'ı settlement'tan önce
  geri alınamaz isim üretebildiği için tek başına activation evidence'i değildir.
- Duplicate-safe order store, payment/permit binding, crash reconciliation, spend
  limits, KMS pause/revoke ve funded failure/refund testleri zorunludur.

## Transaction lifecycle

[Arc transaction lifecycle](https://docs.arc.io/integrate/wallets/transaction-lifecycle)
pending ve final olmak üzere iki ana state tanımlar. Inclusion sonrası reorg
confirmation sayacı gerekmez. Ancak EVM runtime revert de inclusion alabilir.

UI/worker state'i:

```text
pending -> success  (receipt.status == 1 + expected event/state)
        -> failed   (receipt.status == 0 veya expected evidence yok)
```

Receipt varlığını başarı kabul etmek yasaktır.

## ENSIP-15 ve ENS/BENS kanıtı

| İddia | Kaynak | Ürün sonucu |
| --- | --- | --- |
| ENSIP-15 upstream Unicode/spec `17.0.0` | [ENSIP-15](https://docs.ens.domains/ensip/15/) | Exact dependency/profile pin |
| Upstream `spec.json` SHA-256 `4febc8f5d285cbf80d2320fb0c1777ac25e378eb72910c34ec963d0a4e319c84` | [ENSIP-15 version table](https://docs.ens.domains/ensip/15/) | Release evidence'de ayrıca kaydet |
| Normalize sonra labelhash/namehash | [ENS name processing](https://docs.ens.domains/resolution/names/) | Tek canonical pipeline |
| Reverse result forward-confirm edilir | [ENS resolution](https://docs.ens.domains/resolution/) | Verified primary gate |
| Registry interface/event modeli | [ENS registry](https://docs.ens.domains/registry/ens/) | Contract conformance |
| Resolver interface/event modeli | [Resolver interfaces](https://docs.ens.domains/resolvers/interfaces) | Capability/event conformance |

ENSIP-15 kullanıcı kolaylığı için leading/trailing whitespace trim'ine izin verir;
başka sessiz transform yapılmaz. Normalize sonuç kullanıcıya gösterilir.

## BENS kanıtı

[Blockscout BENS integration guide](https://docs.blockscout.com/setup/microservices/blockscout-ens-bens-name-service-integration)
ENS-compatible subgraph, Graph Node deployment, protocol config ve backend/frontend
BENS env bağlantısını ayrı adımlar olarak ister.

Resmî repository evidence'i:

- [BENS README/config](https://raw.githubusercontent.com/blockscout/blockscout-rs/main/blockscout-ens/bens-server/README.md)
- [Production config shape](https://raw.githubusercontent.com/blockscout/blockscout-rs/main/blockscout-ens/bens-server/config/prod.json)
- [Required GraphQL schema](https://raw.githubusercontent.com/blockscout/blockscout-rs/main/blockscout-ens/graph-node/subgraphs/ens-subgraph/schema.graphql)
- [Six-field NameRegistered mapping](https://raw.githubusercontent.com/blockscout/blockscout-rs/main/blockscout-ens/graph-node/subgraphs/bns-subgraph/src/BASERegistrarController.ts)
- [90-day grace mapping](https://raw.githubusercontent.com/blockscout/blockscout-rs/main/blockscout-ens/graph-node/subgraphs/bns-subgraph/src/BaseRegistrarImplementation.ts)
- [Subgraph deployment blocks/events](https://raw.githubusercontent.com/blockscout/blockscout-rs/main/blockscout-ens/graph-node/subgraphs/bns-subgraph/subgraph.yaml)

BENS `primary` sonucu ENS forward-confirmed primary ile eşdeğer değildir. `owner` ve
`registrant` ayrı tutulur. `native_token_contract` BENS config'inde USDC değil registrar
NFT adresidir. Self-hosted BENS first; hosted ArcScan active ayrı operator evidence'i
ister.

## Gateway/x402 ve EIP-3009 kanıtı

| İddia | Kaynak | Karar |
| --- | --- | --- |
| Arc Testnet Gateway domain `26`, nanopayment destekli | [Supported blockchains](https://developers.circle.com/gateway/references/supported-blockchains) | Future capability |
| `network: eip155:5042002`, `scheme: exact`, 6d USDC | [Seller quickstart](https://developers.circle.com/gateway/nanopayments/quickstarts/seller) | Future profile pin |
| GatewayWallet ve chain config SDK'de tanımlı | [SDK reference](https://developers.circle.com/gateway/nanopayments/references/sdk) | Code/address fixture |
| USDC implementation EIP-3009/EIP-2612 ABI içeriyor | [USDC proxy](https://testnet.arcscan.app/address/0x3600000000000000000000000000000000000000), [verified implementation](https://testnet.arcscan.app/address/0x3910B7cbb3341f1F4bF4cEB66e4A2C8f204FE2b8) | Capability var; v1 disabled |

Verified ABI capability tek başına wallet compatibility veya güvenli activation
kanıtı değildir. Proxy implementation/code hash, replay, smart wallet, blocklist ve
exact-delta testleri gerekir.

## ERC-8004 kanıtı

[Arc ERC-8004 tutorial](https://docs.arc.io/arc/tutorials/register-your-first-ai-agent)
Arc Testnet için şu adresleri yayınlar:

- IdentityRegistry `0x8004A818BFB912233c491871b3d84c89A494BD9e`
- ReputationRegistry `0x8004B663056A597Dffe9eCcC1965A193B7388713`
- ValidationRegistry `0x8004Cb1BF31DAf7788923b405b754f57acEB4272`

Ürün bunları optional display olarak kullanır; registration prerequisite, ownership
source veya authorization yapmaz.

## Marka ve logo kanıtı

[Arc Brand Guidelines and Partner Toolkit](https://www.arc.io/brand-guidelines-and-partner-toolkit)
ürün markasının önde, Arc'ın ise altyapı bağlamında kalmasını ister. Arc adı bir ürün,
şirket, uygulama ikonu veya onay/ortaklık iddiasına dönüştürülemez. [Arc terms](https://docs.arc.io/terms)
de yanıltıcı sponsorship, endorsement veya affiliation izlenimini yasaklar. Bu nedenle:

- ürün ve marka **Contour Name Protocol**'dür; `.arc`, “Arc Name Service” veya Arc'ı ürün
  adı gibi kullanan bir adlandırma kullanılmaz;
- doğru ilişki dili “Contour, Arc Testnet üzerinde çalışan bağımsız bir uygulamadır” ve
  kısa network bağlamında “Built on Arc Testnet”tir;
- Arc Testnet entegrasyonu Circle/Arc ortaklığı, sponsorluğu, resmî ürün statüsü veya
  endorsement anlamına gelmez;
- Arc/Circle işareti Contour logosu, app icon'u veya ürün kimliği değildir ve Contour
  markasından daha baskın sunulmaz;
- release 1 arayüzünde Arc logosu kullanılmaz. Gelecekte kullanım gerekirse yalnız güncel
  resmî asset, toolkit, terms ve gerekli approval koşullarıyla; işaret değiştirilmeden ve
  altyapı ilişkisini açıklayacak ölçüde uygulanır;
- trademark/domain check deploy blocker'dır.

Bu toolkit'in yayımlanması tek başına Contour'a “partner” deme veya Circle onayı iddia etme
hakkı vermez. Ürün metni gerçek teknik ilişkiyi açıkça söyler ve bağımsızlık beyanını korur.

## Release-time yeniden doğrulama listesi

- chain ID/RPC/WS/explorer ve `viem` chain definition;
- Arc contract-addresses page + runtime code hashes;
- wallet EIP-3085 metadata davranışı;
- native/ERC20 shared-balance ve dual event receipts;
- transaction receipt/finality behavior;
- ENSIP-15 current version/spec hash ve dependency lock;
- BENS config/schema/mapping upstream commit SHA;
- Circle Gateway supported network/profile/addresses;
- ERC-8004 registry runtime code;
- Arc Brand Guidelines and Partner Toolkit, Arc terms ve kullanılacak güncel brand asset kuralları;
- bütün Contour product addresses/blocks/source verification.

Her değişiklik tarih, source URL, old/new value, impact, owner ve new fixture evidence
ile bu dosyaya veya immutable release evidence kaydına eklenir.
