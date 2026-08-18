# Direct Registration Güvenliği

> **Current runtime note (18 July 2026):** the public UI no longer requests a
> wallet `personal_sign` challenge. After wallet connection and any required
> exact USDC approval, the server prepares the payer-bound contract permit and
> the wallet confirms the registration transaction. Historical challenge-flow
> sections below remain implementation history.

> Release 1 modeli: commit-reveal yok, public çıplak register yok, 180 saniyelik
> wallet-bound single-use EIP-712 permit. Bu belge kontrol tasarımını tanımlar;
> deployment veya security review kanıtı değildir.

## Amaç ve kabul edilen trade-off

Arc'ın hızlı finality'si transaction block'a girdikten sonra geçerlidir; inclusion
öncesi calldata kopyalama ve ordering/sniping riski ortadan kalkmaz. Bu nedenle
controller yalnız yetkili issuer'ın imzaladığı, requester/executor/recipient/price ve
release'e bağlanmış permit kabul eder. Aktif wallet-bound web/issuer yolunda requester,
recipient, payer, authorized executor ve gerçek transaction sender aynı adres olmak zorundadır.

Issuer merkezi bir permit authority'dir. Yeni kayıtları sansürleyebilir ve unavailable
olduğunda sistemi fail-closed durdurur; fakat stateless çalıştığı için label üzerinde
exclusive reservation tutmaz. Ürün “trustless” veya “tam permissionless registration”
iddiası kullanmaz. Kullanıcının kazancı commit secret, commit transaction ve reveal
bekleme adımlarının olmamasıdır.

Kaynaklar:

- [ENS registrar ve commit-reveal](https://docs.ens.domains/registry/eth/)
- [Arc execution layer](https://docs.arc.io/arc/concepts/execution-layer)
- [Arc transaction lifecycle](https://docs.arc.io/integrate/wallets/transaction-lifecycle)

## Permit domain ve payload

EIP-712 domain en az şu değerleri bağlar:

```text
name: Arc Registrar Controller
version: 1
chainId: 5042002
verifyingContract: 0xFbA7618c929075728b82c69B0B2A8C8d98e4B6A3
```

Yalnız draft/deployment-öncesi manifestte `verifyingContract` yoktur ve gerçek permit
üretilemez; canonical active release yukarıdaki exact controller'ı kullanır.
Domain name implementation identifier'dır; ürünün Arc/Circle'a ait olduğunu ifade
etmez.

```text
RegistrationPermit(
  chainId,
  controller,
  releaseId,
  normalizationProfileHash,
  normalizedLabelHash,
  namehash,
  requester,
  recipient,
  payer,
  authorizedExecutor,
  durationYears,
  resolverDataHash,
  referrer,
  settlementAsset,
  expectedAmount,
  expectedReferralBps,
  permitId,
  nonce,
  issuedAt,
  validAfter,
  validUntil
)
```

Her alanın güvenlik amacı:

| Alan | Önlediği sınıf |
| --- | --- |
| chain/controller/release | cross-chain, cross-contract ve stale-release replay |
| profile + label/name hash | Unicode/parity ve farklı isim replay'i |
| requester/recipient/payer | copied calldata ile sahiplik veya ödeme yönü değiştirme; aktif wallet yolunda requester=recipient=payer |
| authorizedExecutor | mempool kopyasını başka sender'ın yürütmesi; requester=executor=sender |
| duration/resolver hash | calldata mutation |
| asset/amount/referral BPS | quote ve token substitution |
| permitId/nonce | exact replay, wallet sequencing ve single-use yürütme |
| time window | stale permit ve uzun-lived reservation |

Zero address kuralları alan bazında explicit olmalıdır. “No referrer” için belirlenen
sentinel dışında requester, recipient, payer, executor, settlement asset ve
controller zero address olamaz.

## Issuance sırası

1. Web, wallet bağlantısından önce issuer readiness'i kontrol eder; mismatch veya
   outage halinde wallet/payment isteği başlatmaz.
2. Wallet Arc'a bağlanır/switch edilir; chain ID RPC ve provider'dan tekrar okunur.
   Bağlı account wallet-bound intent'te requester, recipient, payer ve authorized executor olarak
   aynı değere yazılır; ayrı recipient/gifting alanı yoktur.
3. Raw label trim + exact-pinned ENSIP-15 ile normalize edilir; UI değişen sonucu,
   bağlı wallet alıcısını, duration ve exact yıllık USDC fiyatını gösterir.
4. Server preflight ve bağımsız wallet RPC read'i availability, quote, allowance,
   registration pause ve resolver data'yı doğrular.
5. Allowance yetersizse approval tamamlanır; receipt success ve yeni allowance
   doğrulanır.
6. Chain/account tekrar doğrulanır ve approval sonrası fresh preflight çalışır.
7. Ancak bundan sonra exact wallet-bound intent doğrudan `/api/registration/prepare`
   route'una gönderilir; public UI ek `personal_sign` istemez.
8. Web/Vercel issuer aynı normalization'ı ve origin/chain/controller/release/profile,
   requester/price/allowance/availability/pause/signer/policy state'ini bağımsız tekrarlar.
9. Yalnız server secret store'daki canonical Arc Testnet EOA key'i default 180
   saniyelik EIP-712 permit'i imzalar. Server recovered signer'ı manifest ve controller
   state'iyle yeniden eşleştirir.
10. Client domain/payload/signer'ı, SDK calldata byte parity'sini doğrular ve
    `eth_call` simulation yapar; aradaki chain/account değişikliği fail-closed'dur.
11. Wallet controller'a submit eder. Receipt `status === 1`, aynı receipt'teki exact
    `NameRegistered`/`PermitConsumed` event'leri, token owner/expiry ve registry state
    ile doğrulanır.
12. UI receipt `status`, event, `usedPermit`, owner ve expiry state'ini Arc RPC'den
    doğrular. Response loss veya belirsiz sonuçta yeni permit istemeden önce aynı kontroller
    tekrarlanır.

Ayrı `/api/registration/challenge` + `/issuer/v1/permit` HMAC/`personal_sign` yolu yalnız
geriye uyumluluk içindir. Canonical UI, OpenAPI, hosted MCP ve funded acceptance bu yolu
kullanmaz.

Approval sonrası fiyat/availability değişmişse eski quote ile permit üretilmez.
Allowance sınırsız olmak zorunda değildir; UI exact veya bounded allowance seçimini
açıklar. Approval'a sahip olmak permit veya isim hakkı vermez.

## Time ve TTL politikası

| Değer | Karar |
| --- | --- |
| Default permit TTL | 180 saniye |
| Issuer TTL hard max (`validUntil - issuedAt`) | 295 saniye |
| Controller hard window (`validUntil - validAfter`) | 300 saniye |
| Clock skew | `validAfter = issuedAt - 5s` en fazla |
| Compatibility challenge TTL | exact 120 saniye |

Issuer `validUntil - issuedAt <= 295s` uygular. `validAfter`, küçük clock skew
toleransı için `issuedAt`ten en fazla 5 saniye önce olabildiğinden controller'ın
doğruladığı toplam `validUntil - validAfter` penceresi böylece en fazla 300 saniyedir.
Controller ayrıca `validAfter <= issuedAt <= validUntil` doğrular. Client clock
security boundary değildir; on-chain `block.timestamp` karar verir.

Direct permit `issuedAt` değeri server issuance zamanından gelir. Default permit
`validUntil = issuedAt + 180s` kullanır; prepare anında güvenli transaction süresi
kalmadıysa yeni direct prepare isteği zorunludur.

x402 authorization penceresi Circle akışında en az yaklaşık yedi gün gerektirebilir;
bu süre direct registration permit TTL'siyle birleştirilemez.

## Compatibility-only stateless challenge ve yarış semantiği

Canonical direct issuer kalıcı row veya exclusive lease tutmaz. Geriye uyumlu challenge
route'u kullanılırsa proof şu exact domain-separated preimage'i HMAC-SHA256 altında bağlar:

```text
contour-registration-challenge/v1\n<challengeId>\n<canonical-21-line-message>
```

21 satır domain/origin, chain ID, controller, release ID, request ID, normalized name,
requester/recipient/payer/executor, duration, exact amount, resolver data hash, referrer,
referral BPS, exact intent fingerprint, random 32-byte challenge nonce, `Issued at` ve
`Expires at` değerlerini sabit sıra ve biçimde taşır. HMAC secret en az 32 karakterdir.
Server HMAC'i constant-time karşılaştırır, shape ve exact 120 saniye expiry'yi kendi
saatiyle doğrular, sonra bütün message'ı fresh Arc state'inden yeniden üretir ve wallet
imzasından requester'ı recover eder. Client hiçbir alanı HMAC doğrulamasından sonra
değiştiremez.

Permit ID aynı secret altında ayrı domain ile deterministik türetilir:

```text
HMAC-SHA256(
  REGISTRATION_CHALLENGE_SECRET,
  "contour-registration-permit-id/v1\n" + challengeId + "\n" +
  requestFingerprint + "\n" + requester + "\n" + currentControllerNonce
)
```

Secret çıktıya dâhil değildir. Aynı valid challenge/fingerprint/requester/controller nonce
retry'ı aynı permit ID'yi üretir; fingerprint veya nonce değişimi farklı ID üretir.

Stateless tasarım challenge replay'ini veritabanıyla tek kullanımlı yapmaz ve aynı label
için exclusive sıra garantisi vermez. Bunun yerine zarar şu on-chain kontrollerle
sınırlandırılır:

- her permit current requester nonce'una ve deterministic nonzero `permitId`ye bağlıdır;
- controller `usedPermit`, nonce, deadline, exact quote ve registrar availability'yi
  token çağrısından önce doğrular;
- aynı requester'ın yarışan permit'lerinden ilk başarı nonce'u ilerletir;
- farklı requester'ların yarışında ilk başarılı registration availability'yi kapatır;
- kaybeden transaction ödeme/state bırakmadan atomik revert eder;
- permit veya challenge ownership/reservation garantisi olarak gösterilmez.

Bu trade-off PostgreSQL olmadan yatay serverless çalışmayı mümkün kılar. Transaction
sonucunun tek kaydı Arc receipt'i ve controller/registrar/registry state'idir.

## Web/Vercel issuer boundary

Web BFF bütün registration POST body'lerini streaming 16 KiB cap ile okur. Expensive
challenge, preflight ve verify işleri process-local sekizer; prepare işi dört no-queue
admission slotu kullanır. Slot doluysa request bekletilmez, `503` + `Retry-After: 2`
döner. Bu mekanizma instance-local overload korumasıdır; global abuse/rate limit yerine
geçmez. Vercel Firewall/edge policy request rate ve burst'ü ayrıca sınırlar.

Public browser canonical preflight/prepare route'larına erişir; compatibility
challenge/verify route'ları ayrı tutulur. Direct prepare server'ı:

1. request schema/body cap/origin'i doğrular;
2. exact wallet-bound intent'i normalize eder ve fingerprint'e bağlar;
3. Arc RPC'den chain/controller/release/profile/pause/signer/policy/quote/nonce/
   availability/allowance state'ini fresh okur;
4. request ID, issuance zamanı, fingerprint, requester ve nonce'a bağlı single-use permit
   ID üretir;
5. permit'i `REGISTRATION_PERMIT_SIGNER_PRIVATE_KEY` ile imzalar ve local recovery yapar;
6. signature address'i manifest ve on-chain `permitSigner` ile aynı değilse fail-closed
   `503` döner.

Public issuer/readiness `200`, server signer kopyasının canonical manifest ve on-chain
`permitSigner()` ile parity'sini doğrular. Compatibility challenge route'u etkinse ayrı
HMAC secret da yalnız Vercel/server secret store'da tutulur. Secretlar browser-visible env,
response, log, source map veya evidence bundle'a yazılmaz. `X-Forwarded-For` gibi kullanıcı
kontrollü header'lar authentication değildir. Process-local limits çok-instance global
rate limit sağlamaz; edge/WAF bu residual riski üstlenir.

## Controller doğrulama sırası

Mevcut `ArcRegistrarController.register` implementation'ının gerçek sırası:

1. `nonReentrant` guard ve `registrationsPaused`;
2. permit `chainId` + controller, sonra release ID ve normalization profile;
3. requester/recipient/payer/executor zero-address, referrer ilişkisi,
   `requester == payer == authorizedExecutor` ve `msg.sender == authorizedExecutor`;
   aktif issuer sınırı buna ek olarak `recipient == requester` uygular;
4. normalized UTF-8 validation/code-point sayımı, labelhash ve namehash parity;
5. duration, resolver data hash ve exact settlement asset;
6. current quote ve current referral BPS exact equality;
7. nonzero/unused permit ID ve requester nonce;
8. `validAfter <= issuedAt <= validUntil`, en fazla 5 saniye skew, en fazla
   300 saniyelik `validUntil - validAfter` window ve current block time;
9. EIP-712 recovery'nin current `permitSigner` ile eşleşmesi;
10. registrar availability;
11. `usedPermit` ve nonce effects + `PermitConsumed` event'i;
12. ERC-20 `transferFrom` ve exact balance delta;
13. referral liability/accounting ve solvency check;
14. registrar/registry/resolver registration state değişimi;
15. `NameRegistered` event'i.

Yani signature recovery ve availability, price/nonce/time guard'larından sonra fakat
herhangi bir token çağrısından önce çalışır. Permit/nonce effect'i token çağrısından
önce yazılır; aşağıdaki external call veya registration revert ederse EVM atomicity
bu effect ve event'i de geri alır.

Successful re-registration'da registrar registry node'un geçici owner'ıyken public
resolver `clearRecords(node)` ile record version'ını ilerletir, resolver'ı seçer ve
registry TTL'ini `0` yapar. Ardından yalnız yeni permit'e bağlı resolver initialization
çalışır ve recipient owner atanır. Payment, reset, NFT replacement, TTL, resolver data
ve final ownership aynı transaction'da olduğundan bir failure önceki owner/expiry/TTL
veya resolver kayıtlarını kısmen değiştiremez.

Bir external token call reentrancy yaratabilir; checks-effects-interactions ve
reentrancy guard birlikte kullanılmalıdır. Ancak permit'in revertte consumed kalması
yasaktır; EVM transaction atomicity'si test edilir.

## Signer yönetimi

### Key custody

- Bu Arc Testnet-only release aynı fonlanmış secp256k1 EOA'yı deployer, protocol owner,
  treasury ve permit signer olarak kullanabilir.
- Private key'in server-runtime kopyası Vercel/server secret store'da
  `REGISTRATION_PERMIT_SIGNER_PRIVATE_KEY` olarak tutulur; public readiness derived signer
  parity'sini doğrular. Key repository, `.env.example` değeri, CI output,
  log, crash response, source map, browser veya evidence'e girmez. Yerel deploy/admin
  kopyası da public deployment paketine yüklenmez.
- Her imzadan sonra local EIP-712 recovery canonical/on-chain signer ile eşleştirilir.
- Multisig, rol ayrımı ve KMS/HSM bu testnet release'i için zorunlu değildir. Bunun açık
  bedeli, server secret erişiminin permit üretimi yanında tam protocol/treasury admin
  yetkisini de tehlikeye atmasıdır.
- Key'in şifreli/offline yedeği ve erişim/kurtarma testi tutulur. Audit log yalnız permit
  ID/hash, policy version ve success/failure sınıfını taşıyabilir; raw label, challenge,
  wallet signature veya private key materyali loglanmaz.

### On-chain authority

Signer immutable değildir. Tek EOA kontrolündeki policy şu incident sırasını kullanır:

```text
normal rotation -> yeni EOA hazırla -> owner/treasury/signer state'ini taşı -> parity doğrula
compromise -> issuance kapat -> mümkünse pause/revoke -> policy/release bump veya clean redeploy
```

Permit signer replacement controller'da iki aşamalıdır ve proposal sonrası 24 saatlik
activation delay uygular; ikinci blockchain imzası/multisig şart değildir. Normal rotation
drill'i canonical signer'ı değiştirmeden throwaway fork/release üzerinde event/receipt ve
delay boundary'siyle kanıtlanır. Compromise halinde:

1. signer revoke ve issuance pause;
2. outstanding permit penceresinin dolmasını bekleme veya release/profile
   invalidation;
3. on-chain used permit/nonce ve son issuance zaman aralığı audit'i;
4. yeni EOA'ya owner/treasury/signer rotation; eski EOA güvenli biçimde kullanılamıyorsa
   yeni release ID ve temiz deployment;
5. public policy version/release update ve incident report.

Owner, treasury veya signer değişiklikleri role evidence'e girer. Tek EOA'nın bu dört
rolü birden taşıması bilinçli testnet kararıdır; mainnet güvenlik modeli olarak sunulamaz.

## Normalization güvenliği

ENSIP-15 implementation ve upstream spec hash'i lockfile + manifest + release ID ile
pinlenir. Canonical corpus en az şunları kapsar:

- NFC/compatibility ve confusable örnekleri;
- emoji/ZWJ/variation selector;
- combining marks;
- mixed-script valid/invalid durumları;
- leading/trailing whitespace trim;
- ASCII `.` ile `。` (U+3002), `．` (U+FF0E), `｡` (U+FF61), empty, null byte ve
  invalid UTF-8; normalization sonrası oluşan nokta ayrıca yeniden kontrol edilir;
- 1/2/3/4 code point fiyat sınırları;
- 63/64 byte ve code point sınırları;
- UI/issuer/SDK/event/subgraph labelhash/namehash/tokenId golden vectors.

Dependency veya corpus değişikliği yeni profile hash + release ID gerektirir; eski
permit yeni profilde kabul edilmez.

## USDC ödeme güvenliği

Settlement asset yalnız resmî Arc ERC-20 USDC adresidir:
`0x3600000000000000000000000000000000000000`, 6 decimals. Controller transfer
öncesi ve sonrası ERC-20 `balanceOf(this)` farkını exact expected amount ile
karşılaştırır. Native 18-decimal balance ekonomik delta hesabına eklenmez.

Arc native/ERC-20 shared balance nedeniyle:

- native sweep yasak;
- balanceOf altı decimal dust gösterebilir;
- native transfer solvency görünümünü etkileyebilir;
- yalnız liabilities üzerindeki ERC-20-visible surplus çekilebilir;
- USDC blocklist runtime revert'i tam işlem revert'i olarak test edilir.

EIP-3009 ve EIP-2612 capability'si canlı implementation ABI'sinde bulunsa da v1
execution path'inde kapalıdır. Enable gate:

- proxy implementation/code hash kontrolü;
- EOA ve smart-wallet/EIP-1271 fallback;
- nonce/replay/cancel authorization;
- blocklist ve expired authorization;
- exact delta + shared balance;
- funded MetaMask/Rabby fixture ve rollback planı.

## Front-running ve replay testleri

Zorunlu negatif testler:

- attacker aynı calldata'yı kendi sender'ından submit eder;
- attacker recipient/payer/executor/resolver/referrer değiştirir;
- aynı permit iki kez kullanılır;
- aynı nonce farklı permit ID ile veya tersi denenir;
- wrong chain/controller/release/profile/asset;
- permit not-yet-valid, expired, issuer TTL'si 295 saniyeden uzun veya controller
  window'u 300 saniyeden uzun;
- price/referral/duration availability imzadan sonra değişir;
- permit signer revoke edilir;
- compatibility route etkinse challenge HMAC bit flip, wrong origin/release/fingerprint,
  expiry ve replay;
- signer secret eksik/yanlış, recovered address mismatch veya response loss;
- aynı requester ve farklı requester'larla aynı label için eşzamanlı permit yarışları;
- allowance/payment revert'i permit'i consumed veya herhangi bir kısmi state bırakır.

Arc receipt inclusion finaldir fakat runtime revert de final olabilir. Test ve UI
receipt presence yerine `status`, contract address, event ve state'i doğrular.

## Privacy ve logging

Raw registration label hassas olmasa bile kullanıcı intent'idir ve pre-registration
sniping riskini artırabilir. Registration/challenge API'lerinde label request body'de
kalır; URL query, analytics event, structured application log veya generic exception'a
yazılmaz. Structured loglarda normalized labelhash + request/permit ID tercih edilir;
wallet signature, challenge body, HMAC ve signer materyali redact edilir; log retention/
operator erişimi sınırlandırılır ve support export'ları açık onay olmadan payload içermez.

Public lookup route'u `/name/[label]` bu genel kuralın görünür istisnasıdır: path
segmenti browser history'ye ve request uygulamaya ulaşmadan önce edge/CDN/reverse
proxy'ye gider. Uygulama yalnız normalize edilip kullanıcıya gösterilmiş public label'a
navigate etmelidir; doğrudan raw URL isteğinin ilk hop'ta loglanmadığını garanti
edemez. Bu nedenle deployment access-log policy'si `/name/*` segmentini redact/hash
etmeli veya o route için path logging'i kapatmalıdır. Bu konfigürasyon kanıtlanmadan
raw-label leakage gate'i PASS olamaz.

## Release gate

Direct registration active olmadan önce aşağıdaki evidence zorunludur:

- contract unit/fuzz/invariant suite;
- canonical normalization corpus parity;
- direct request fingerprint/permit ID/nonce/TTL tamper testleri; compatibility route
  etkinse ayrıca canonical HMAC tamper/expiry/replay ve wallet recovery testleri;
- aynı label için concurrent permit yarışlarının yalnız bir successful on-chain result
  üretmesi ve kaybeden transaction'ın ödeme/state bırakmaması;
- EOA secret injection ve local recovery; throwaway fork/release üzerinde 24 saatlik
  signer activation/rotation/revoke, canonical suite'te non-destructive pause/readiness
  ve clean-redeploy rehearsal drill'i;
- funded Arc Testnet approval + register E2E;
- copied calldata ve replay saldırı fixture'ları;
- USDC shared-balance, blocklist ve exact-delta testleri;
- MetaMask/Rabby desktop/mobile wallet flow;
- raw-label leakage scan;
- BFF 16 KiB/body ve no-queue admission saturation testi; edge rate policy, secret-leak
  ve readiness parity testleri; compatibility route etkinse ayrıca challenge HMAC testi;
- pause, recovery ve incident runbook.

Evidence yoksa permit endpoint health verse bile direct-registration release'i
`productLive` olamaz; manifestteki `active + productLive:false` yalnız private candidate'dır.
