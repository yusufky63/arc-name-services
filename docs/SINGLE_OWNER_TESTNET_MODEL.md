# Tek sahipli Arc Testnet yönetim modeli

Contour Name Protocol'ün yeni Arc Testnet release'i tek bir fonlanmış EOA'yı deployer,
protocol owner, treasury ve kısa ömürlü registration permit'lerinin signer'ı olarak
kullanır. Multisig Safe, ikinci/üçüncü owner, threshold imzası, rol ayrımı, managed
KMS/HSM veya Safe keystore parolası release gereksinimi değildir.

Bu EOA'nın private key'i deploy/admin işlemleri için kontrollü yerel operator ortamındadır.
Permit imzalama için aynı key'in server-only kopyası deployment secret store'dadır; public
issuer readiness derived local signer, canonical manifest ve on-chain `permitSigner()`
parity'sini `200` ile doğrular. Key browser'a, frontend environment'ına, source map'e, loga
veya evidence'e girmez.

Canonical target:

- release ID: `0x66aeb7b208fdfb6eb9f728a3d0b12d6d3b7132eb0e363b38f7c388c358edefdc`;
- deployer/owner/treasury/permit signer:
  `0x78de409a6306550882328E2a67160471368387FF`.

Clean deployment 15/15 successful transaction ile tamamlanmış; yedi canonical adres
[`ARCHITECTURE.md`](ARCHITECTURE.md) ve root [`README.md`](../README.md) içinde listelenmiştir.

## Neden temiz redeploy gerekti?

Önceki ve artık retired olan configured/paused kontratlar 2-of-3 Safe'e aitti. O Safe'in
gerekli threshold imzaları olmadan ownership transferi, signer değişimi, unpause veya
treasury değişikliği yapılamıyordu. Bir Safe'i belge veya environment değiştirerek tek
EOA'ya dönüştürmek mümkün değildir. Bu yüzden eski adresler retired tarihsel evidence
olarak korunur ve yeni canonical release'e karıştırılmaz. Mevcut canonical kontratlar ise
tek fonlanmış EOA ile yönetilen yeni suite'tir.

Yeni release şu özelliklerle sıfırdan deploy edildi:

- yeni release ID ve yedi yeni kontrat adresi;
- registrar, controller ve marketplace için aynı fonlanmış EOA owner;
- controller ve marketplace için aynı EOA treasury;
- registry root/reverse-root sahipliği deployment sonunda aynı EOA ile doğrulanır;
- aktivasyon için aynı EOA'ya bağlı server-only permit signer secret; ayrı HMAC challenge
  secret yalnız compatibility route'u içindir ve canonical direct `/prepare` akışının
  readiness şartı değildir;
- başlangıçta controller ve marketplace paused;
- source verification, manifest/evidence, funded smoke ve rollback doğrulamasından sonra
  tek EOA'nın admin transaction'larıyla kontrollü unpause.

## Anahtar saklama ve risk

Tek EOA modeli testnet operasyonunu basitleştirir fakat multisig güvenliği sağlamaz.
Owner key ele geçirilirse saldırgan signer'ı, fiyat/policy alanlarını, treasury'yi ve pause
durumunu değiştirebilir veya surplus çekebilir. Anahtar kaybolursa admin kontrolü geri
alınamayabilir. Bunlar kabul edilen, açıkça belgelenen testnet riskleridir.

Asgari koruma:

- deploy/admin private key dosyası yalnız yerel operator secret'ında tutulur; git,
  Vercel source upload'u, browser, source map, log ve evidence'e girmez. Runtime signer
  kopyası yalnız Vercel Sensitive server environment'ında tutulur ve public readiness
  signer parity'sini doğrular;
- owner key'in şifreli/offline yedeği ve kurtarma testi zorunludur; bu exact release için
  immutable offline-recovery/clean-redeploy kanıtı henüz yoktur ve ilgili gate `BLOCKED` kalır;
- işlem öncesi target, calldata, value, chain ID ve beklenen state değişimi ikinci bir
  insan/operator kontrolüyle incelenir; ikinci blockchain imzası gerekmez;
- server/EOA compromise'ında önce issuer kapatılır; EOA hâlâ güvenilir biçimde kontrol
  edilebiliyorsa controller ve marketplace pause edilir, signer/owner yeni EOA'ya rotate
  edilir; bu güvence yoksa yeni release ile temiz redeploy edilir;
- owner rotation eski EOA'nın `transferOwnership(newOwner)` çağrısı, yeni EOA'nın
  `acceptOwnership()` çağrısı, treasury güncellemesi ve bütün on-chain parity kontrolleriyle
  yapılır. Eski owner kullanılamıyorsa rotation mümkün değildir ve temiz redeploy gerekir.

## Ayrı capability'ler

Core registration issuer PostgreSQL veya KMS/HSM istemez. BENS core değildir ve kapalıdır;
self-host edilirse Graph Node/BENS'in kendi PostgreSQL'i gerekir. x402 Release 1'de kapalı
ve fail-closed kalır.
