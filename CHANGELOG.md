# Changelog

## [0.6.0](https://github.com/snktibor/usageratio/compare/v0.5.0...v0.6.0) (2026-10-09)


### Features

* group/machine selection and a compact card in the macOS menu bar app ([#12](https://github.com/snktibor/usageratio/issues/12)) ([33260b7](https://github.com/snktibor/usageratio/commit/33260b74dd1841a9f104a8aeeb347700ef232d72))
* **macos:** redesign the menu bar card ([#14](https://github.com/snktibor/usageratio/issues/14)) ([c342510](https://github.com/snktibor/usageratio/commit/c3425102d132dfa08de9224c697b50dcadc41776))
* upload providers' own usage from the macOS app, with a reset per provider ([#16](https://github.com/snktibor/usageratio/issues/16)) ([48f1faa](https://github.com/snktibor/usageratio/commit/48f1faa5f4355b6dac4762729f416e99902b232f))

## [0.5.0](https://github.com/snktibor/usageratio/compare/v0.4.0...v0.5.0) (2026-10-07)


### Features

* macOS menu bar app with GET /api/status and read-only tokens ([#10](https://github.com/snktibor/usageratio/issues/10)) ([75603d9](https://github.com/snktibor/usageratio/commit/75603d92c8c33b7f67b6bed7b87404793bc49b7a))

## [0.4.0](https://github.com/snktibor/usageratio/compare/v0.3.0...v0.4.0) (2026-10-01)


### Features

* **cycle-history:** implement scrolling behavior for cycle list with max height ([aa73da1](https://github.com/snktibor/usageratio/commit/aa73da16923625135c2c1890ec8de459fd6283a9))

## [0.3.0](https://github.com/snktibor/usageratio/compare/v0.2.0...v0.3.0) (2026-09-30)


### Features

* **charts:** the zoom window, its sampling and its time axis ([0fa80fb](https://github.com/snktibor/usageratio/commit/0fa80fbb993409487bf914bad51b02a1bcea2a55))
* **charts:** zoom into the usage and model charts ([fd9643e](https://github.com/snktibor/usageratio/commit/fd9643e4e13becd1c55a4adad412b90bca31d6a8))
* **dashboard:** open a past cycle read-only from the previous cycles ([c9d67e5](https://github.com/snktibor/usageratio/commit/c9d67e5ac240750a790ca0410220a4dae1e38d90))
* **group-breakdown:** refactor to use GroupRows component for better readability ([111d10f](https://github.com/snktibor/usageratio/commit/111d10f2a75751f474b4b43840031a8392072bed))
* **group-machines:** implement group machines chart and breakdown functionality ([111d10f](https://github.com/snktibor/usageratio/commit/111d10f2a75751f474b4b43840031a8392072bed))
* **history:** work out which past cycles can be opened, and how ([55e2735](https://github.com/snktibor/usageratio/commit/55e27354d3281828391a8f84a273d7d074f803b6))
* **settings:** move the settings dialog to its own page ([a674710](https://github.com/snktibor/usageratio/commit/a674710a2d3078b4124095caeede21b8ec057e4f))


### Bug Fixes

* **dashboard:** drop the cycle picker above the dashboard ([2f456c3](https://github.com/snktibor/usageratio/commit/2f456c348b22053ae8806675c4164bdaf6c84bc8))
* **i18n:** update translations for group machines description and aria labels ([111d10f](https://github.com/snktibor/usageratio/commit/111d10f2a75751f474b4b43840031a8392072bed))
* **settings:** ask for the PIN inside the machine merge dialog ([e32944b](https://github.com/snktibor/usageratio/commit/e32944b02c8f6530c765fb4d1bf88e0c026198aa))

## [0.2.0](https://github.com/snktibor/usageratio/compare/v0.1.0...v0.2.0) (2026-09-29)


### Features

* add CI workflow for automated testing and build process ([c0ae45e](https://github.com/snktibor/usageratio/commit/c0ae45e05de876d47ab627cc80a448b0683fbbaf))
* add German language support and update routing and middleware configurations ([4682bb6](https://github.com/snktibor/usageratio/commit/4682bb684e4e630e27d4bd15f8206e995fc7af33))
* add GitHub credit link to dashboard and update installation instructions in multiple languages ([1067eca](https://github.com/snktibor/usageratio/commit/1067ecae8e0cb976c1acee8604a7204e3e0cdfb5))
* add license section to README and specify Node.js engine version in package files ([fe2490e](https://github.com/snktibor/usageratio/commit/fe2490ea2cefbd3edf408a2df3a12ecb9eed7ac3))
* add manual and automatic usage reporting scripts for Bash and PowerShell ([950f392](https://github.com/snktibor/usageratio/commit/950f3929c84a4ea1c20c6920bfc5e1b0f1a82959))
* **alerts:** threshold webhook alerts for the settings panel ([1e2ba93](https://github.com/snktibor/usageratio/commit/1e2ba93b82a4902661e0080b993857b667e932ae))
* **api-token:** copy the API token on the setup page, stored with AES-256-GCM ([bcee9b8](https://github.com/snktibor/usageratio/commit/bcee9b8517fc1fdf23134d4c7541409add29eff6))
* **auth:** passphrase PINs, no global lockout DoS, rolling sessions, sudo for the token reveal ([e37f1c9](https://github.com/snktibor/usageratio/commit/e37f1c91b97b44ca6c8f47f93747bbc0d6f8aa84))
* **brand:** add apple touch icon, social preview, and render script ([a87d3e9](https://github.com/snktibor/usageratio/commit/a87d3e94bcd78182d894ffa0d4d35e15343ff62d))
* **brand:** add logo and mark SVGs for README and avatars ([2ddd42d](https://github.com/snktibor/usageratio/commit/2ddd42df08c24a215db8001879f478f6185438aa))
* **brand:** render Open Graph and Twitter card images per locale ([10295b3](https://github.com/snktibor/usageratio/commit/10295b3b51493f2c811b14bf35338721e6b55ae4))
* **clients:** --tokens takes provider=count; raise the ink-3 contrast to AA ([b4eaa04](https://github.com/snktibor/usageratio/commit/b4eaa0482f0a5dc99fe577353039505c08d1001f))
* **clients:** jitter automatic reports so machines don't all report at :00 ([7aa4d16](https://github.com/snktibor/usageratio/commit/7aa4d16badc04b05cd979bfb3440f62793091058))
* **clients:** manual machines are no longer marked "late" ([369a297](https://github.com/snktibor/usageratio/commit/369a29734de1e96836d1222c135b40cc658684b2))
* **clients:** pin ccusage to a fixed version, prefer it over npx on Windows ([33ab442](https://github.com/snktibor/usageratio/commit/33ab442ad273b9f30a5ada0a4a12a89a913e394c))
* **cost:** add opt-in API-list-price cost estimate ([6242588](https://github.com/snktibor/usageratio/commit/6242588676f79937cfac787e8702b8d9383fce8e))
* **dashboard:** chart each sub-limit next to the groups, in a fainter shade ([3e1d7d6](https://github.com/snktibor/usageratio/commit/3e1d7d64d1ae48d787df62d86a5b6652745caa10))
* **dashboard:** chart usage over the cycle, by group and by model ([d7c3c30](https://github.com/snktibor/usageratio/commit/d7c3c30e7d53a4f9ebac893c81e8941aaf6e12e5))
* **dashboard:** locale-aware widgets, save-status feedback, and SSR-stable provider selection ([4cb1d8b](https://github.com/snktibor/usageratio/commit/4cb1d8b0543462b42407a39b0c7f675a3da17ba7))
* **dashboard:** sub-limits inside an AI account, such as Claude's Fable ([04f29a0](https://github.com/snktibor/usageratio/commit/04f29a0d572fb0756eac183f8dd53674bc7d13ef))
* **demo:** pre-archive a handful of plausible past cycles ([338ce26](https://github.com/snktibor/usageratio/commit/338ce260e8a3e473a1c4a5fa4bce1d80e9641f3b))
* **deploy:** add Docker self-hosting stack ([b04b9d9](https://github.com/snktibor/usageratio/commit/b04b9d97c5d234c60e51e7136b0106b38d5e79e6))
* enhance machine management with merging and group handling ([e4c257b](https://github.com/snktibor/usageratio/commit/e4c257bcbf2f01da35beeea501b67f8f23917a01))
* enhance README with deployment button and additional badges ([b5399c5](https://github.com/snktibor/usageratio/commit/b5399c5fb1d72677092a7a75e8b83950059d10f2))
* enhance setup API with locale-aware redirection and improve token settings UI ([444022d](https://github.com/snktibor/usageratio/commit/444022deba47dc2d40b3cbc9e3b4f97295358596))
* **history:** archive cycle summaries and add a usage export endpoint ([b90f159](https://github.com/snktibor/usageratio/commit/b90f159597d8feff0baf7dd4c6aefa7f537b09de))
* **history:** archive finished cycles from the daily housekeeping run too ([2e75828](https://github.com/snktibor/usageratio/commit/2e75828713efddcaa1f9569c73b18d08f6ef5540))
* **housekeeping:** prune stale index and audit entries on a schedule ([6278bd7](https://github.com/snktibor/usageratio/commit/6278bd71a3ad6b61b2cc9e79c347b41e0b24cf7d))
* **i18n:** add LanguageSwitcher component and integrate into settings dialog ([e298869](https://github.com/snktibor/usageratio/commit/e298869eff1791789494f59efaed95a935f11021))
* **i18n:** add multi-language support with Hungarian and English translations ([7d986a1](https://github.com/snktibor/usageratio/commit/7d986a107ecdbc1968eaa0450afc18ee58ff6278))
* **i18n:** implement multi-language support for settings and token components ([867628b](https://github.com/snktibor/usageratio/commit/867628b8e3f21ae0d95257af557797458c41974e))
* **i18n:** settings dialog texts in all three languages ([9fb6f86](https://github.com/snktibor/usageratio/commit/9fb6f86116db3238f658da1c6c8a1e8e3e560908))
* **i18n:** update Hungarian translations for dashboard and settings components ([f513372](https://github.com/snktibor/usageratio/commit/f513372320dfafdd173ee0cafdaa73f15c9b749d))
* implement clipboard functionality for copying API tokens and text ([f7519d8](https://github.com/snktibor/usageratio/commit/f7519d856198743f424d7da61d98a03d1c0571d3))
* implement dynamic locale handling and add locale generation script ([31f8da9](https://github.com/snktibor/usageratio/commit/31f8da936bda4b73bea48c9ab6c4cbaee04a1948))
* implement sub-limit mismatch detection and add related tests ([d7676c7](https://github.com/snktibor/usageratio/commit/d7676c726b8a1b9c8eb204b51716404b96f34c33))
* in-memory store, demo mode, request context, structured logs and API helpers ([dc9fcfa](https://github.com/snktibor/usageratio/commit/dc9fcfa018695e8cd0cb5e3f1803cb50b911b84e))
* initialize project with Next.js, TypeScript, and Vitest ([5f3aa17](https://github.com/snktibor/usageratio/commit/5f3aa17b8e569f1e0b4a705c5ea7d485db5bd76d))
* **manage:** rename/delete/merge machines, groups and providers ([e084d39](https://github.com/snktibor/usageratio/commit/e084d39db788cfe891fb409ba325276b9326bc1b))
* **migrate:** add a one-off script for the legacy DeepSeek-only keys ([eea335c](https://github.com/snktibor/usageratio/commit/eea335cb046fe33a1fa77c70af40d0ab0fe08b07))
* **observability:** add a webhook error reporter ([63b7185](https://github.com/snktibor/usageratio/commit/63b7185b8161d70df0293d1dda7ccc3ee8ac327e))
* **official-usage:** store the ground-truth field in Redis, not localStorage ([d7d48b0](https://github.com/snktibor/usageratio/commit/d7d48b042adb5ef07d6b460e69506e850af2db41))
* refactor usage reporting to support multiple providers ([0e1a52c](https://github.com/snktibor/usageratio/commit/0e1a52c443018562179e6589a50dcc21fc980d8a))
* **routing:** English default locale, typed error/not-found/loading pages, PIN error codes ([6392925](https://github.com/snktibor/usageratio/commit/6392925f64193eb88431c209553807d3778bedf3))
* **security:** nonce-based CSP, hardened headers, and a violation-report endpoint ([8f7f22e](https://github.com/snktibor/usageratio/commit/8f7f22e5b380d36c2679e23eafe6cd370c265583))
* **settings:** add showRemaining option to control token visibility in dashboard ([2a8c480](https://github.com/snktibor/usageratio/commit/2a8c48030b2ac585bd42d898842ace348960c804))
* **settings:** choose which AI accounts show, and which groups count for each ([4641304](https://github.com/snktibor/usageratio/commit/4641304421ae1993535dd3595afda2b2294e7270))
* **settings:** make the token limits optional and off by default ([0f75356](https://github.com/snktibor/usageratio/commit/0f7535623920a10cd2a1607e7de983b2e6264a62))
* **settings:** the reset weekday list and month days follow the viewer's locale ([6ed088f](https://github.com/snktibor/usageratio/commit/6ed088f151f68077f703c166bb116a7006c4956c))
* **settings:** time zone becomes a per-deployment setting ([fe4b446](https://github.com/snktibor/usageratio/commit/fe4b446c0ad5cb86e5c4853f8edaa393d10bf9ba))
* **settings:** time zone picker on the settings panel ([8a75dd7](https://github.com/snktibor/usageratio/commit/8a75dd74d8c35a0dbb62bc025d1412e96a3768b8))
* **setup:** add a client setup page with ZIP packages and installers ([013bc47](https://github.com/snktibor/usageratio/commit/013bc475fd9663791047fbc0800cf55565e6a03f))
* **setup:** add functionality to save and restore setup preferences using cookies ([cb81f56](https://github.com/snktibor/usageratio/commit/cb81f56183276302f9aca217218ef3efe41a1530))
* **setup:** add Linux installer and update setup logic for cross-platform compatibility ([1f749fc](https://github.com/snktibor/usageratio/commit/1f749fc0242fd2a487144ea30189dc86152b97d5))
* **setup:** add route handling for installation methods and update setup preferences ([c27754d](https://github.com/snktibor/usageratio/commit/c27754d6276818cde2184b8f6b80dc7fda3ee9c6))
* **setup:** enhance setup documentation for Vercel and manual configuration ([5142144](https://github.com/snktibor/usageratio/commit/51421446ced06f46ebdc26030b950b97a2cbb471))
* **setup:** improve text clarity and consistency in setup instructions ([2d9af73](https://github.com/snktibor/usageratio/commit/2d9af73d4c9d145e5677c9215d9652a0b6a4ceea))
* **setup:** refine Hungarian text for clarity in setup instructions ([cd62e73](https://github.com/snktibor/usageratio/commit/cd62e73f200e8ebf0d07e8f873d971d70ae529a5))
* **setup:** replace section with details for improved accessibility and user interaction ([ab69ec2](https://github.com/snktibor/usageratio/commit/ab69ec2000eb13157bacc33b243a5ce51dc89c0b))
* **setup:** translate the setup page and split setup-view into components/setup/** ([2a93289](https://github.com/snktibor/usageratio/commit/2a9328918696b1bd217072c6ccdc32c7330a53aa))
* **tests:** enhance cycle tests with monthly budget scenarios and edge cases ([241067e](https://github.com/snktibor/usageratio/commit/241067e88b33a367d455c8472da335a090e44ac0))
* **tests:** update dashboard tests to reflect new color handling and group logic ([241067e](https://github.com/snktibor/usageratio/commit/241067e88b33a367d455c8472da335a090e44ac0))
* **tokens:** add revocable per-machine API tokens ([8776d02](https://github.com/snktibor/usageratio/commit/8776d02bc786a8c25b938edafa779763fedee768))
* typed messages and message keys instead of Hungarian text in lib/api-token.ts ([b6e79d2](https://github.com/snktibor/usageratio/commit/b6e79d2f3a5bd4108950c8afad92b6e503342ea8))
* **usage:** backfill the charts from each report's split by day ([8277615](https://github.com/snktibor/usageratio/commit/827761556443c06acb4c0f56889a0ea64259338d))
* **usage:** ingest rate limits and registry caps ([906b6e7](https://github.com/snktibor/usageratio/commit/906b6e79aa786bab95fe2b8a78d1d0d3ba283b27))
* **usage:** split Claude Code's usage by clock hour ([02a9a45](https://github.com/snktibor/usageratio/commit/02a9a45291d4d21bab9c98729ddbc79b96eca05f))
* **validation:** export parseId function for improved ID parsing ([241067e](https://github.com/snktibor/usageratio/commit/241067e88b33a367d455c8472da335a090e44ac0))
* **vault:** rotate TOKEN_ENCRYPTION_KEY and stop keeping raw audit IPs ([df227f5](https://github.com/snktibor/usageratio/commit/df227f5479d05aca4096b0cae53ad418cf22c24d))


### Bug Fixes

* **api:** unhandled route errors reach the error webhook; the setup ZIP locale reads the request's own cookie ([3365e63](https://github.com/snktibor/usageratio/commit/3365e63702f8eaad2e21b6fc4ceed6aee1c0f1b2))
* **audit-dialog:** add overscroll containment to audit dialog ([e19dec4](https://github.com/snktibor/usageratio/commit/e19dec43edd00b14cb5e94080e10fb6670f47804))
* **clients:** keep Windows PowerShell 5.1 reading ccusage through npm notices ([1071994](https://github.com/snktibor/usageratio/commit/1071994cb3a4879b032700e363257c34a19b9c68))
* **clients:** shellcheck and PSScriptAnalyzer clean, so the new CI starts green ([56b4f11](https://github.com/snktibor/usageratio/commit/56b4f116bda16b08acd53da0780265c65a1c483e))
* **dashboard:** an empty state instead of a crash when no provider is known yet ([fdaabbf](https://github.com/snktibor/usageratio/commit/fdaabbfdc7640a3e6e17cedf8774ffc016570f6c))
* **dashboard:** bring back the made-by credit in the footer ([f4adc74](https://github.com/snktibor/usageratio/commit/f4adc74900a2c94571d728b80706c685fcee4faa))
* **i18n:** period texts as ICU selects, a separated sub-limit status line, demo opens on Claude ([d28dcd3](https://github.com/snktibor/usageratio/commit/d28dcd3ab95eaa0c65cff0cf3216d465aa3c93f4))
* **log:** keep the logger free of server-only imports ([7825597](https://github.com/snktibor/usageratio/commit/7825597920afebddbf940798dbfa5624cecd4287))
* **settings-dialog:** add overscroll containment to settings dialog ([0ddbf7e](https://github.com/snktibor/usageratio/commit/0ddbf7e16ec25ac45d11cabd24174fa190a3d93f))
* **settings:** call providers providers, and move deleting one to a danger zone at the bottom ([1231df5](https://github.com/snktibor/usageratio/commit/1231df5a77dabc233b82c15aa568979fb608d279))
* **settings:** explain per-machine tokens and pick the machine from the known ones ([62789ee](https://github.com/snktibor/usageratio/commit/62789ee31781ee0138282d46815354cafcd2e40f))
* **settings:** keep the token machine picker in step with the machine list ([c2b5699](https://github.com/snktibor/usageratio/commit/c2b5699eeb727bd44cddfaa269cb2b9c5797ba95))
* **settings:** list each machine once, and rename or delete it for every provider ([27ba1ce](https://github.com/snktibor/usageratio/commit/27ba1ce6cbb32767d9dd3020f7efcdaf7a03393e))
* **settings:** searchable time zone field that refuses unknown zones ([65e79c5](https://github.com/snktibor/usageratio/commit/65e79c5b95496bd545a5a081a04a7131ee3155dc))
* **settings:** stop the PIN prompt from submitting natively inside the settings form ([91ad300](https://github.com/snktibor/usageratio/commit/91ad3001fdba80e9b0f8f21be53d87e3db115809))
* **settings:** type alert thresholds into a list instead of preset chips, up to 20 ([0434541](https://github.com/snktibor/usageratio/commit/0434541a4ee5c8f18fc078741a04fce1589ee9f9))
* **settings:** widen the settings dialog to 48rem ([90d420f](https://github.com/snktibor/usageratio/commit/90d420f6c0b1582e5c5fcd2c3051bb33c37efa71))
* **setup:** let the PIN submit finish the token and one-shot command copy ([9d6b0f1](https://github.com/snktibor/usageratio/commit/9d6b0f19c4341b5f05a5a7986dc93e06bae6f646))
* **setup:** remember the cost-estimate opt-in in the setup prefs cookie ([de03728](https://github.com/snktibor/usageratio/commit/de03728db56224472763eb56da30168814eceed0))
* the provider choice survives a reload, and missing pages answer 404 ([681325c](https://github.com/snktibor/usageratio/commit/681325ce383a068123d0e308960ea8ba31f72b42))
* update cookie path in writeSetupPrefs function for broader accessibility ([c2605fd](https://github.com/snktibor/usageratio/commit/c2605fd9c56602f3836a2d56df3d1fd51213a2d2))
* **usage-summary:** ensure highest running total is retained in snapshot mode ([9cd96dc](https://github.com/snktibor/usageratio/commit/9cd96dc5f1f1139505aadc08e16fe900440ddf64))
* **usage:** drop the phantom DeepSeek default, accept heartbeats ([75bb4bf](https://github.com/snktibor/usageratio/commit/75bb4bfbb8b78a5668fb4f9a6fd490ae0de06c00))
* **vercel:** set the Next.js framework preset in vercel.json ([69c9754](https://github.com/snktibor/usageratio/commit/69c975400d0d6ac9a1adddb98fd100bba7a713d0))


### Code Refactoring

* **api:** route cookies without next/headers, migrate JSON routes to shared helpers ([4fd2b74](https://github.com/snktibor/usageratio/commit/4fd2b74528d489a6b85a290033bc3f5b57b7f186))
* **clients:** merge the macOS and Linux installers into one script ([c50ee98](https://github.com/snktibor/usageratio/commit/c50ee9866f7f8d4297e717885e86d8d2bf047343))
* **clients:** replace the provider if-chain with an ordered registry ([81a24a6](https://github.com/snktibor/usageratio/commit/81a24a6ba47ec97c5538b8144c880f97742d9853))
* **redis:** move the key layout into lib/redis-keys.ts ([9839d60](https://github.com/snktibor/usageratio/commit/9839d605d053056b407afd2bc700ecbc83ebcbb7))
* **settings:** split the settings dialog into sections ([d5c7196](https://github.com/snktibor/usageratio/commit/d5c7196ae7cc56c61d4c6a3cc636a23d0c52c2b7))


### Documentation

* add contributor guide, code of conduct and security policy ([3aa43df](https://github.com/snktibor/usageratio/commit/3aa43df98ad42509fe52b627cf2deb8280e2f210))
* add self-hosting guide ([ddd9d6b](https://github.com/snktibor/usageratio/commit/ddd9d6b724828365a737f7a632377f779896f3f6))
* **agents:** document project conventions for AI coding agents ([26ab4cd](https://github.com/snktibor/usageratio/commit/26ab4cdcd4ddea45ad75a355ef0f822c3f7555ee))
* **api:** note that demo mode blocks the housekeeping cron before the secret check ([91a614d](https://github.com/snktibor/usageratio/commit/91a614dbd9b2435abf768f5d64e22b83e0e3a3b5))
* **assets:** add generated README screenshots ([fb0e285](https://github.com/snktibor/usageratio/commit/fb0e2851d74c0c1876c6dadd4ab4fdc2bf985c7b))
* **assets:** regenerate the screenshots and the social preview from the final UI ([eb76ee2](https://github.com/snktibor/usageratio/commit/eb76ee22626082e46e0359806774e62dc0269e5e))
* correct facts found in review of the rewritten docs ([2c66069](https://github.com/snktibor/usageratio/commit/2c66069ee76f10bba1f0d090f12c427c222a616b))
* describe history archiving from the daily housekeeping run ([8876109](https://github.com/snktibor/usageratio/commit/8876109accc7f5bc2aa8cad2d0de241b81730b31))
* **readme:** record the Cloudflare DNS record and how Deployment Protection behaves ([fe1fd25](https://github.com/snktibor/usageratio/commit/fe1fd25dec1d68845c6613e39bea39732acf6239))
* **readme:** rewrite as the project's open-source showcase ([736f2ad](https://github.com/snktibor/usageratio/commit/736f2adabe878155b739dc27812dd64e8f567b1d))
* rewrite docs/ as accurate, topic-based pages ([da613e0](https://github.com/snktibor/usageratio/commit/da613e094621484598297b1d18732065aa150ad2))
