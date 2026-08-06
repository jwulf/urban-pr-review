# [0.14.0](https://github.com/jwulf/urban-pr-review/compare/v0.13.0...v0.14.0) (2026-08-06)


### Features

* **merge:** execute a per-repo merge protocol (fresh head run + [@mergifyio](https://github.com/mergifyio) queue) ([#44](https://github.com/jwulf/urban-pr-review/issues/44)) ([712a0eb](https://github.com/jwulf/urban-pr-review/commit/712a0eb212616152a13a23b2306bebc19349746d)), closes [#43](https://github.com/jwulf/urban-pr-review/issues/43)

# [0.13.0](https://github.com/jwulf/urban-pr-review/compare/v0.12.4...v0.13.0) (2026-08-06)


### Features

* **pages:** make the pull-request list collapsible, remembered across sessions ([#41](https://github.com/jwulf/urban-pr-review/issues/41)) ([62e9249](https://github.com/jwulf/urban-pr-review/commit/62e924949b109f14657d103f1b69c9535ce3f205))

## [0.12.4](https://github.com/jwulf/urban-pr-review/compare/v0.12.3...v0.12.4) (2026-08-06)


### Bug Fixes

* **escalation:** make no-result rounds recoverable from the UI ([#38](https://github.com/jwulf/urban-pr-review/issues/38)) ([b7259a0](https://github.com/jwulf/urban-pr-review/commit/b7259a042fddfeee4f6bce90461e171afda5dc9f)), closes [597/#599](https://github.com/jwulf/urban-pr-review/issues/599)

## [0.12.3](https://github.com/jwulf/urban-pr-review/compare/v0.12.2...v0.12.3) (2026-08-06)


### Bug Fixes

* **prompts:** deliver agent base prompts as a variable bridge (unblock review resubmit) ([#37](https://github.com/jwulf/urban-pr-review/issues/37)) ([6ae1c05](https://github.com/jwulf/urban-pr-review/commit/6ae1c057c947b4251d5f390fb3beed4ffa61125f)), closes [#36](https://github.com/jwulf/urban-pr-review/issues/36) [#31](https://github.com/jwulf/urban-pr-review/issues/31) [597/#599](https://github.com/jwulf/urban-pr-review/issues/599) [#36](https://github.com/jwulf/urban-pr-review/issues/36)

## [0.12.2](https://github.com/jwulf/urban-pr-review/compare/v0.12.1...v0.12.2) (2026-08-06)


### Bug Fixes

* adopt urban 0.22 for {{template}} substitution + guard prompt-less agents ([#35](https://github.com/jwulf/urban-pr-review/issues/35)) ([6ad92c1](https://github.com/jwulf/urban-pr-review/commit/6ad92c1d1c73c87e43efc49958a5b9a41debfb13)), closes [#34](https://github.com/jwulf/urban-pr-review/issues/34) [#597](https://github.com/jwulf/urban-pr-review/issues/597) [#599](https://github.com/jwulf/urban-pr-review/issues/599) [#31](https://github.com/jwulf/urban-pr-review/issues/31) [#106](https://github.com/jwulf/urban-pr-review/issues/106) [jwulf/urban-pr-review#34](https://github.com/jwulf/urban-pr-review/issues/34)

## [0.12.1](https://github.com/jwulf/urban-pr-review/compare/v0.12.0...v0.12.1) (2026-08-05)


### Bug Fixes

* adopt @nanobpm/urban 0.21.0 (grid row-detail collapse) + add Renovate ([#33](https://github.com/jwulf/urban-pr-review/issues/33)) ([7d75b46](https://github.com/jwulf/urban-pr-review/commit/7d75b46c443e75477aab78ee576ef94c02d182ce))

# [0.12.0](https://github.com/jwulf/urban-pr-review/compare/v0.11.0...v0.12.0) (2026-08-05)


### Features

* harden review-wait against permanent stalls ([#32](https://github.com/jwulf/urban-pr-review/issues/32)) ([8303357](https://github.com/jwulf/urban-pr-review/commit/83033579a382e7d235dc8f248c821150a29ea121))

# [0.11.0](https://github.com/jwulf/urban-pr-review/compare/v0.10.0...v0.11.0) (2026-08-05)


### Features

* model-authored template-header prompts + senior:fix-ci auto-fix loop ([#31](https://github.com/jwulf/urban-pr-review/issues/31)) ([761213a](https://github.com/jwulf/urban-pr-review/commit/761213ae65a26e29594bca8ad0e78a48c435d8c0)), closes [nano-ide#106](https://github.com/nano-ide/issues/106) [jwulf/urban-pr-review#29](https://github.com/jwulf/urban-pr-review/issues/29)

# [0.10.0](https://github.com/jwulf/urban-pr-review/compare/v0.9.0...v0.10.0) (2026-08-05)


### Features

* gate a wave's implementation on the prior wave merging ([#30](https://github.com/jwulf/urban-pr-review/issues/30)) ([6f07fc4](https://github.com/jwulf/urban-pr-review/commit/6f07fc4771fc797ea5d61cd1c17aafce9f1c2dda))

# [0.9.0](https://github.com/jwulf/urban-pr-review/compare/v0.8.0...v0.9.0) (2026-08-05)


### Features

* configurable review-round cap (default 20) + submit-form field ([#27](https://github.com/jwulf/urban-pr-review/issues/27)) ([ee8e314](https://github.com/jwulf/urban-pr-review/commit/ee8e3140b15b02cf0a8a1f268187f539debfe211))

# [0.8.0](https://github.com/jwulf/urban-pr-review/compare/v0.7.0...v0.8.0) (2026-08-05)


### Features

* adversarial plan-review gate before fan-out dispatch ([#26](https://github.com/jwulf/urban-pr-review/issues/26)) ([1634c80](https://github.com/jwulf/urban-pr-review/commit/1634c80dfe0953f9a6739b8690ad0c5b7a990c74))

# [0.7.0](https://github.com/jwulf/urban-pr-review/compare/v0.6.0...v0.7.0) (2026-08-04)


### Features

* mixed sequential + parallel plan fan-out via dependency waves ([#21](https://github.com/jwulf/urban-pr-review/issues/21)) ([ee67032](https://github.com/jwulf/urban-pr-review/commit/ee6703235e081a8c20f2e8b7d76ebc2282450f51)), closes [#20](https://github.com/jwulf/urban-pr-review/issues/20) [#20](https://github.com/jwulf/urban-pr-review/issues/20)

# [0.6.0](https://github.com/jwulf/urban-pr-review/compare/v0.5.0...v0.6.0) (2026-08-04)


### Features

* make PR list entries clickable new-tab links ([#19](https://github.com/jwulf/urban-pr-review/issues/19)) ([cd73a02](https://github.com/jwulf/urban-pr-review/commit/cd73a0276f33ccafdd6e2f28d0d55bd40abc6b90))

# [0.5.0](https://github.com/jwulf/urban-pr-review/compare/v0.4.0...v0.5.0) (2026-08-04)


### Features

* plan-fanout — decompose an issue into a fleet of PRs ([#14](https://github.com/jwulf/urban-pr-review/issues/14)) ([#17](https://github.com/jwulf/urban-pr-review/issues/17)) ([462a8d7](https://github.com/jwulf/urban-pr-review/commit/462a8d7fd1360db8a1f5f7ae65dd2ff86dfc8b5a))

# [0.4.0](https://github.com/jwulf/urban-pr-review/compare/v0.3.1...v0.4.0) (2026-08-03)


### Features

* GET /app/status + cancel-by-prKey affordances ([#12](https://github.com/jwulf/urban-pr-review/issues/12)) ([9fbe066](https://github.com/jwulf/urban-pr-review/commit/9fbe066992b18529b485324b476ef031b4814565))

## [0.3.1](https://github.com/jwulf/urban-pr-review/compare/v0.3.0...v0.3.1) (2026-08-03)


### Bug Fixes

* **deps:** bump @nanobpm/urban to ^0.17.1 ([#11](https://github.com/jwulf/urban-pr-review/issues/11)) ([00d6a68](https://github.com/jwulf/urban-pr-review/commit/00d6a68e39d01369bd50784c846e97651a0022ac))

# [0.3.0](https://github.com/jwulf/urban-pr-review/compare/v0.2.1...v0.3.0) (2026-08-03)


### Features

* **poller:** read GitHub reviews via the host `gh` CLI ([#10](https://github.com/jwulf/urban-pr-review/issues/10)) ([d04c12e](https://github.com/jwulf/urban-pr-review/commit/d04c12e9de30276d2d6cae2405330146f2e9540f))

## [0.2.1](https://github.com/jwulf/urban-pr-review/compare/v0.2.0...v0.2.1) (2026-07-31)


### Bug Fixes

* add license, repository metadata, and marketplace manifest ([3382cfb](https://github.com/jwulf/urban-pr-review/commit/3382cfb404d5a76d8eec2f7cb1abd36cb889ef14))
