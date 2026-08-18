# Agent, MCP, ERC-8004 ve x402

> Release 1: registration, marketplace, hosted MCP reads and unsigned plans are
> operational on Arc Testnet. ERC-8004 remains optional; no Contour-owned x402
> payment endpoint is advertised without a durable service.

## Yetki ayrımı

```text
MCP read/plan          private key yok, imza yok, broadcast yok
Wallet execution      kullanıcı wallet'ı imzalar ve broadcast eder
Permit issuer         yalnız RegistrationPermit imzalar; tx/private wallet tutmaz
x402 keeper           ayrı KMS, allowlist ve spend policy; release 1 disabled
ERC-8004               optional identity metadata; ownership source değil
```

Bu sınırlar tek API key veya ortak private key ile birleştirilemez.

## MCP yüzeyi

Hosted `/api/mcp` yüzeyi şudur:

- resource: `contour://runtime` (HTTPS-only runtime discovery);
- reads: `normalize_label`, `get_name`, `reverse_lookup`,
  `get_account_names`, `get_market`;
- request helpers: `prepare_registration_request`, `prepare_permit_request`;
- unsigned plans: `prepare_approval`, `prepare_renewal`,
  `prepare_market_token_approval`, `prepare_market_token_approval_revoke`,
  `prepare_market_usdc_approval`, `prepare_market_listing`, `prepare_market_buy`,
  `prepare_market_cancel`, `prepare_claim_proceeds`, `prepare_claim_referral`,
  `prepare_transfer`, `prepare_market_invalidate`.

`prepare_approval` geriye uyumlu registration-controller USDC allowance planıdır.
Marketplace alımı için `prepare_market_usdc_approval`, ilan yetkisi için
`prepare_market_token_approval` kullanılmalıdır. Cancel, token approval revoke, seller/referral
liability claim ve stale-listing invalidation planları marketplace pause sırasında da üretilir;
listing, buy ve yeni marketplace approval planları pause durumunda fail-closed kalır.

Kanonik manifest signed release kanıtıdır; hosted resource ayrı runtime şemasıdır.
Registration ve marketplace on-chain policy'leri açık, permit issuer hazırdır.
`productLive` promotion kanıtı bu operasyonel kabiliyetlerden ayrı tutulur ve
eksik evidence varmış gibi gösterilmez.

Hosted `prepare_registration_request` ve `prepare_permit_request` aynı input/output
şemasını kullanır: `rawLabel`, `normalizationAccepted`, `account`, `durationYears` ve
opsiyonel `requestId` alıp `/api/registration/prepare` için çalıştırılmamış bir POST
şablonu döndürür. Permit adlı tool yalnız compatibility alias'tır; issuer-v1 challenge
ve permit body'lerini üretmez, istek yapmaz veya wallet imzası atmaz.

Repository-local stdio MCP'nin resource'u `contour://manifest`, ayrı kayıt yardımcısı
`prepare_issuer_request`'tir. Bu tool tam issuer intent'ini alır ve `v1/challenges` ile
`v1/permits` için iki ayrı POST şablonu döndürür; HTTP çağrısını veya challenge imzasını
kendisi yapmaz. Hosted ve stdio helper şemaları birbirinin yerine kullanılamaz.

`get_manifest`,
`get_release`, `get_chain_profile`, ayrı `get_owner`/`get_resolver`/`get_price`/
`get_availability`, `list_market`, `plan_register`, `plan_set_records` ve `plan_claim`
isimli tool'lar bu release package'ında ship edilmemiştir; bunlar ancak schema,
capability ve testleri eklenecek future surface önerileridir. Manifest resource'unu
tool varmış gibi belgelemek yasaktır.

MCP:

- seed/private key/KMS signer erişimi taşımaz;
- EIP-712 veya transaction imzalamaz;
- transaction veya payment authorization broadcast etmez;
- BENS sonucunu ownership truth yapmaz;
- active manifest yoksa executable target üretmez;
- schema-invalid chain/controller/release/profile alanlarında fail-closed olur;
- stored ABI URL/hash veya `sourceVerified` flag'ini runtime code/role kanıtı saymaz;
  bu parity acceptance artefaktında ayrıca doğrulanır.

Ship edilen unsigned plan'ın exact envelope'u şudur:

```text
kind, chainId, to, data, value=0, description
```

Settlement asset, expected amount ve guard'lar calldata/description içinde olabilir;
release ID, ABI hash, expiry ve normalization profile/corpus hash şu an plan objesine
ayrı alan olarak embed edilmez. Bunlar manifest resource'u ve permit request/response
ile ayrıca doğrulanır. İleride enriched plan envelope ship edilirse versioned schema
ve tamper testleriyle eklenmelidir; mevcut output'a aitmiş gibi belgelenemez. `value`
protocol payment için sıfırdır; native USDC yalnız network fee katmanıdır.

## ERC-8004 opsiyonel agent kimliği

Arc Testnet resmî tutorial'ındaki registry adresleri:

| Registry | Arc Testnet adresi |
| --- | --- |
| IdentityRegistry | `0x8004A818BFB912233c491871b3d84c89A494BD9e` |
| ReputationRegistry | `0x8004B663056A597Dffe9eCcC1965A193B7388713` |
| ValidationRegistry | `0x8004Cb1BF31DAf7788923b405b754f57acEB4272` |

Kaynak: [Register your first AI agent](https://docs.arc.io/arc/tutorials/register-your-first-ai-agent).

Bu adresler Arc sistem entegrasyon adresleridir; Contour ürün kontrat adresleri
değildir. Kullanım policy'si:

```text
ERC-8004 agent ID
  + ACTIVE .contour name
  + reverse candidate
  + forward addr(name) == agent owner/address
  = verified display identity
```

ERC-8004:

- isim kaydı için zorunlu değildir;
- ownership veya authorization kaynağı değildir;
- reputation/validation sonucu protokol guarantee'si değildir;
- registry RPC hatasında core name read/registration akışını bozamaz;
- manifest capability false iken UI badge göstermemelidir.

Kaynak: [Arc agentic economy](https://docs.arc.io/build/agentic-economy).

## Arc üzerindeki Gateway/x402 profili

Circle Gateway Nanopayments Arc Testnet'i destekler:

```text
chain: arcTestnet
network: eip155:5042002
Gateway domain: 26
scheme: exact
asset: 0x3600000000000000000000000000000000000000
asset decimals: 6
SDK: @circle-fin/x402-batching
GatewayWallet: 0x0077777d7EBA4688BDeF3E311b846F25870A19B9
```

Kaynaklar:

- [Gateway supported blockchains](https://developers.circle.com/gateway/references/supported-blockchains)
- [Seller quickstart](https://developers.circle.com/gateway/nanopayments/quickstarts/seller)
- [Nanopayments SDK reference](https://developers.circle.com/gateway/nanopayments/references/sdk)
- [Arc contract addresses](https://docs.arc.io/arc/references/contract-addresses)

Gateway nanopayment raw USDC token üzerindeki sıradan direct EIP-3009 çağrısı
değildir. Kullanıcı önce Gateway balance'a deposit eder; authorization
`GatewayWalletBatched` alanına ve custom payment semantics'e bağlıdır.

Kaynak: [Gateway x402 concept](https://developers.circle.com/gateway/nanopayments/concepts/x402).

## Settlement-sequence çelişkisi

Circle seller quickstart production'da ayrı `verify()` ardından `settle()` yerine
doğrudan `settle()` çağrılmasını ve middleware'in resource'u vermeden önce settlement
yapmasını önerir. Payment `validBefore` penceresinin en az yaklaşık yedi gün + buffer
olmasını da ister.

Name registration geri alınamaz bir on-chain service'tir:

| Sıra | Risk |
| --- | --- |
| `settle -> register` | register revert ederse ödeme alınmış, isim verilmemiş olur |
| `register -> settle` | settle başarısızsa isim verilmiş, ödeme alınmamış olur |
| paralel | atomiklik sağlamaz; iki bağımsız final state yarışır |

Pasted ürün blueprint'inin `registration_confirmed -> payment_settled` sırası Circle'ın
production seller önerisiyle çelişir. Circle Gateway belgelerinde Contour için atomik
register+settle veya hazır refund endpoint'i kanıtlanmadığından güvenli varsayılan:

```text
X402_ENABLED=false
manifest.x402.active=false
server.ts startup refusal -> HTTP listener/paid route mount edilmez
X402_ENABLED=true olsa bile eksik managed adapters nedeniyle startup yine reddedilir
```

Bu nedenle shipped davranış `503` döndüren canlı bir route değildir: process route
mount etmeden çıkar ve permit/payment başlatamaz. Bu bir UX eksikliği değil release
security gate'tir.

Kaynaklar:

- [Seller quickstart](https://developers.circle.com/gateway/nanopayments/quickstarts/seller)
- [Batched settlement](https://developers.circle.com/gateway/nanopayments/concepts/batched-settlement)

## Gelecekteki order modeli

x402 ileride ayrı funded beta olarak ele alınır. Her order şunlara bağlanır:

```text
orderId / idempotencyKey / requestFingerprint
chainId / controller / releaseId / normalizationProfileHash
normalizedLabelHash / recipient / payer / authorized keeper
duration / resolverDataHash / exact amount / referral
registration permitId + permit window
Gateway payment identifier + authorization window
registration txHash/receipt + settlement evidence
compensation/refund txHash + operator decision (gerektiğinde)
```

Payment authorization'ın yedi günlük penceresi label'ı yedi gün reserve etmez.
Execution anında fresh 180 saniyelik RegistrationPermit üretilir. Stale quote,
registered label veya changed release yeni permit almadan önce reddedilir.

Repository'deki `KeeperWorkflow` yalnız inactive bir registration-first risk
skeleton'ıdır:

```text
happy path:
quoted -> permit_issued -> payment_authorized
       -> registration_submitted -> registration_confirmed -> payment_settled

failure branches:
payment_authorized | registration_submitted | registration_confirmed | payment_settled
  -> refund_pending -> refunded
any nonterminal state -> manual_review
```

Exact stored state seti `quoted`, `permit_issued`, `payment_authorized`,
`registration_submitted`, `registration_confirmed`, `payment_settled`,
`refund_pending`, `refunded`, `manual_review`'dur.

Buradaki `payment_authorized`, settlement değildir. Skeleton registration'ı önce
submit/confirm edip Gateway settlement'ını sonra dener; settlement failure halinde
isim geri alınamayacağından satıcıya ücretsiz isim/seller-credit riski bırakır.
`manual_review` bu riski telafi etmez. Server'ın startup refusal'ı ve manifest flag'i
bu nedenle kaldırılmaz.

Activation tasarımı ya settle-first + registration failure için açık, fonlanmış ve
audit edilmiş compensation; ya da registration-first + açıkça kabul edilmiş seller
credit, exposure/spend limitleri ve reconciliation seçmelidir. Compensation Gateway
refund diye varsayılamaz. Seçilen model kod, threat review ve funded failure E2E ile
kanıtlanmadan mevcut skeleton “complete” veya paid route sayılamaz.

## Idempotency ve reconciliation

- Idempotency key account/agent + normalized label + request body fingerprint'e
  bağlanır.
- Aynı key/farklı body `409` olur.
- Response loss sonrası mevcut order döndürülür; ikinci payment/registration yok.
- Keeper receipt presence yerine `status === 1`, controller/event/token owner'ı
  doğrular.
- Settlement evidence registration başarısı olarak yorumlanmaz.
- Registration evidence payment başarısı olarak yorumlanmaz.
- Worker crash sonrası order DB + Gateway state + Arc receipt uzlaştırılır.
- Unknown state otomatik retry yerine bounded retry sonrası manual review'a gider.
- Compensation duplicate-safe ve liability ledger ile solvent olmalıdır.

## Keeper sınırı

Gelecekte keeper:

- permit'te `authorizedExecutor` olarak açıkça bağlanır;
- yalnız allowlisted Arc chain/controller/release ve USDC asset'i kabul eder;
- ayrı KMS key ve ayrı IAM role kullanır;
- per-order, per-wallet, rolling-window ve global spend limitleri uygular;
- pause, key revoke ve queue drain runbook'u taşır;
- arbitrary calldata, target veya native value gönderemez;
- MCP/web permit signer ile aynı key'i paylaşamaz.

Raw payment authorization, wallet signature veya personal request loglara yazılmaz.
Structured audit logları yalnız order ID ve hashed identifiers kullanır.

## Direct EIP-3009 ayrı bir feature'dır

Arc USDC proxy implementation ABI'sinde `transferWithAuthorization`,
`receiveWithAuthorization`, `cancelAuthorization`, `authorizationState`, EIP-2612
`permit`, `nonces` ve `DOMAIN_SEPARATOR` görülür:

- [Arc USDC proxy](https://testnet.arcscan.app/address/0x3600000000000000000000000000000000000000)
- [Verified implementation](https://testnet.arcscan.app/address/0x3910B7cbb3341f1F4bF4cEB66e4A2C8f204FE2b8)

Bu capability x402/Gateway ile aynı değildir. Release 1'de direct EIP-3009 da
disabled'dır. Enable gate EOA/EIP-1271 fallback, nonce/replay, cancel/expiry,
blocklist, exact-delta, proxy/code-hash ve wallet fixture'larını gerektirir.

## x402 activation gate

`X402_ENABLED=true` ve manifest capability ancak aşağıdaki kanıtların tamamıyla aynı
release change set'inde açılabilir:

- Circle supported profile canlı discovery;
- funded Gateway deposit/authorization/settlement E2E;
- seçilmiş settlement ordering policy ve threat review;
- automatic compensation veya açık seller-risk policy;
- funded duplicate-safe refund/compensation E2E;
- payment/permit/order exact binding;
- duplicate, timeout, response loss, stale permit ve already-registered race;
- keeper KMS, allowlist, spend limit, pause/revoke drill;
- DB backup/restore ve crash reconciliation;
- structured audit logları, operator runbook'u ve manual-review SLA;
- public UX price/fee/settlement disclosure;
- independent security review.

Bu kanıtlardan biri eksikse x402 fail-closed kalır; “beta” etiketi güvenlik gate'inin
yerini tutmaz.
