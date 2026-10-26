#!/usr/bin/env ruby
# Structural policy checks for .github/workflows/*.yml (no network, no secrets). Used by
# scripts/test-release-policy.sh, which also mutation-tests it.
#
#   check-workflow-policy.rb <workflow.yml>...      prints one VIOLATION line per problem, exit 1 if any
#
# Rules for EVERY workflow: top-level read-only permissions; a timeout-minutes on every job; every
# checkout has persist-credentials: false; no `secrets: inherit` / toJSON(secrets); a secret (other than
# GITHUB_TOKEN) appears only in a step-level `env:` value, never in `run`, `with`, `if`, job or workflow
# env; a job that runs dependency code (pnpm/cargo/bun/npm/docker/tauri/...) has no environment, no
# secret and no write permission.
# A PRIVILEGED job (has an environment, any secret other than GITHUB_TOKEN, or a write permission) may use
# only an allow-list of actions (checkout / download-artifact / upload-artifact, and attest-build-provenance
# in `attest-provenance`) and runs no package manager, interpreter or downloader (the one pinned minisign
# install step excepted, byte for byte).
# Extra rules for a file named release.yml: see check_release below (job graph, where each secret may
# appear, the fresh-runner sign-macos job, artifact names, preflight / publish guards).
require 'yaml'

DEP_RUN = /\b(pnpm|npm|npx|yarn|bun|cargo|rustup|prep-sidecar|brew|pip3?|gem|docker)\b|go (install|build)/
DEP_USES = %r{\A(tauri-apps/|pnpm/|dtolnay/|actions/setup-|Swatinem/|taiki-e/|oven-sh/)}
SIGN_FORBIDDEN_RUN = /\b(pnpm|npm|npx|yarn|bun|cargo|rustup|brew|pip3?|gem|docker|node|apt-get|apt|curl|wget)\b|go (install|build)/
SIGN_ALLOWED_SCRIPTS = %w[macos-ci-sign.sh macos-unpack-unsigned.sh macos-repack-dmg.sh macos-verify-signed.sh package-cli-tarball.sh recompress-dmg.sh]
# privileged jobs (every workflow): no installs, build tools, interpreters or downloaders
PRIV_FORBIDDEN_RUN = /\b(pnpm|npm|npx|yarn|bun|cargo|rustup|brew|pip3?|gem|docker|node|python3?|ruby|perl|apt-get|apt|dpkg|curl|wget|nc|ssh|scp|sudo|eval)\b|go (install|build)|\|\s*(ba|z|da)?sh\b/
PRIV_ALLOWED_USES = %r{\Aactions/(checkout|download-artifact|upload-artifact)@}
ATTEST_USES = %r{\Aactions/attest-build-provenance@}
MINISIGN_STEP = 'Install minisign (pinned sha256)'
MINISIGN_BODY = <<~'BODY'.lines.map(&:strip).reject(&:empty?)
  set -euo pipefail
  d="$RUNNER_TEMP/minisign"
  mkdir -p "$d"
  curl -fsSL --proto '=https' -o "$d/minisign.tar.gz" https://github.com/jedisct1/minisign/releases/download/0.11/minisign-0.11-linux.tar.gz
  echo "f0a0954413df8531befed169e447a66da6868d79052ed7e892e50a4291af7ae0  $d/minisign.tar.gz" | sha256sum -c -
  tar -xzf "$d/minisign.tar.gz" -C "$d" minisign-linux/x86_64/minisign
  echo "$d/minisign-linux/x86_64" >> "$GITHUB_PATH"
  "$d/minisign-linux/x86_64/minisign" -v
BODY
VALIDATE_STEP = 'Validate release ref (before any repo code runs)'
CLEANUP_STEPS = ['Remove signing keychain', 'Remove App Store Connect API key file']
EXPECT_NEEDS = {
  'preflight' => [], 'build-cli' => %w[preflight], 'build-desktop' => %w[preflight],
  'sign-macos' => %w[preflight build-cli build-desktop], 'smoke-cli-macos' => %w[sign-macos],
  'sign-manifest' => %w[preflight build-cli build-desktop sign-macos smoke-cli-macos],
  'attest-provenance' => %w[sign-manifest], 'publish-release' => %w[sign-manifest attest-provenance],
}
# Every `run` line of the three secret/write jobs must match one of these (anchored; no pipes, `;`, `&&`,
# command substitution or redirects except the exact forms below), so nothing else can be appended.
ARGS = %q{[\w ./"${}\[\]:*@=+,%-]*}
RUN_COMMON = [
  /\Aset -euo pipefail\z/, /\Afi\z/, /\Aelse\z/, /\Adone\z/,
  /\A[A-Za-z_][A-Za-z0-9_]*="?#{ARGS}"?\z/,
  /\Aapps=\("\$RUNNER_TEMP"\/work\/desktop\/app\/\*\.app\)\z/,
  /\A(mkdir -p|cp|cat|rm -f|ls -la) #{ARGS}\z/,
  /\Atest "\$\(git rev-parse HEAD\)" = "\$GITHUB_SHA"\z/,
  /\Ashasum -a 256 #{ARGS} \| cut -d' ' -f1 > #{ARGS}\z/,
  /\ATAG="\$\(bash scripts\/resolve-release-tag\.sh\)"\z/,
  /\Aecho "tag=\$TAG" >> "\$GITHUB_OUTPUT"\z/,
  /\Aecho "(?:[^"`\\$]|\$(?!\())*"\z/,
]
RUN_PUBLISH_EXACT = [
  'if bash scripts/resolve-release-tag.sh --is-prerelease "$TAG"; then',
  'echo "is_prerelease=true" >> "$GITHUB_OUTPUT"', 'echo "is_prerelease=false" >> "$GITHUB_OUTPUT"',
  'if [ -f "$F" ]; then', 'echo "path=$F" >> "$GITHUB_OUTPUT"', 'echo "path=" >> "$GITHUB_OUTPUT"',
  'args=(--draft --verify-tag --title "Release $TAG")',
  'if [ "$PRERELEASE" = true ]; then args+=(--prerelease); fi',
  'if [ -n "$NOTES" ]; then args+=(--notes-file "$NOTES"); else args+=(--generate-notes); fi',
  'if ! gh release view "$TAG" >/dev/null 2>&1; then gh release create "$TAG" "${args[@]}"; fi',
  'gh release upload "$TAG" release-assets/* --clobber',
  %q{want="$(cd release-assets && printf '%s\n' * | sort)"},
  %q{have="$(gh release view "$TAG" --json assets --jq '.assets[].name' | sort)"},
  '[ "$want" = "$have" ] || { echo "::error::draft release assets differ from the signed set"; exit 1; }',
  'gh release edit "$TAG" --draft=false',
]
RUN_MANIFEST_EXACT = ['for f in release-assets/*.sha256; do']
JOB_SCRIPTS = {
  'sign-macos' => SIGN_ALLOWED_SCRIPTS,
  'sign-manifest' => %w[resolve-release-tag.sh collect-release-assets.sh check-release-key-not-placeholder.sh make-release-manifest.sh sign-release-manifest.sh],
  'publish-release' => %w[resolve-release-tag.sh check-release-not-published.sh],
}
SIGN_ALLOWED_USES = %r{\Aactions/(checkout|download-artifact|upload-artifact)@}
KEY3 = %w[APPLE_API_KEY_P8 APPLE_API_KEY_ID APPLE_API_ISSUER]
# step name regex => exactly these secrets (sign-macos only). Detect is special-cased.
SIGN_STEP_SECRETS = {
  /\AImport signing certificate\z/ => %w[APPLE_CERTIFICATE APPLE_CERTIFICATE_PASSWORD],
  /\ASign macOS CLI binaries\z/ => %w[APPLE_SIGNING_IDENTITY],
  /\ANotarize macOS CLI binaries\z/ => KEY3,
  /\ASign macOS app / => %w[APPLE_SIGNING_IDENTITY],
  /\ANotarize and staple macOS app\z/ => KEY3,
  /\ASign, notarize and staple dmg container\z/ => %w[APPLE_SIGNING_IDENTITY] + KEY3,
}
APPLE7 = %w[APPLE_CERTIFICATE APPLE_CERTIFICATE_PASSWORD APPLE_SIGNING_IDENTITY APPLE_TEAM_ID] + KEY3

def strip_comments(s)
  s.to_s.lines.reject { |l| l.strip.start_with?('#') }.join
end

def walk(node, path = [], &blk)
  case node
  when Hash then node.each { |k, v| walk(v, path + [k], &blk) }
  when Array then node.each_with_index { |v, i| walk(v, path + [i], &blk) }
  when String then blk.call(path, node)
  end
end

def secrets_in(str)
  str.scan(/(?<![\w.-])secrets\.([A-Za-z0-9_]+)/).flatten.reject { |n| n == 'GITHUB_TOKEN' }
end

def check_generic(file, raw, wf, v)
  v << "#{file}: `secrets: inherit` or toJSON(secrets) / secrets[...] is forbidden" if raw =~ /secrets:\s*inherit|toJSON\(\s*secrets\s*\)|secrets\[/
  perms = wf['permissions']
  if !perms.is_a?(Hash) || perms['contents'] != 'read' || perms.values.any? { |x| x == 'write' }
    v << "#{file}: workflow-level permissions must be read-only (contents: read)"
  end
  walk(wf) do |path, str|
    secrets_in(str).each do |n|
      ok = path.length == 6 && path[0] == 'jobs' && path[2] == 'steps' && path[4] == 'env'
      v << "#{file}: secrets.#{n} at #{path.join('.')} (allowed only in a step-level env: value)" unless ok
    end
  end
  (wf['jobs'] || {}).each do |jid, job|
    v << "#{file}: job #{jid} has no timeout-minutes" unless job['timeout-minutes'].is_a?(Integer)
    steps = job['steps'] || []
    steps.each do |s|
      next unless s['uses'].to_s.start_with?('actions/checkout@')
      v << "#{file}: job #{jid}: checkout without persist-credentials: false" unless s.dig('with', 'persist-credentials') == false
    end
    write_perm = (job['permissions'].is_a?(Hash) ? job['permissions'] : {}).values.include?('write')
    priv_secrets = []
    walk(job) { |_p, str| priv_secrets.concat(secrets_in(str)) }
    if job['environment'] || !priv_secrets.empty? || write_perm
      steps.each do |s|
        u = s['uses'].to_s
        unless u.empty? || u.match?(PRIV_ALLOWED_USES) || (jid == 'attest-provenance' && u.match?(ATTEST_USES))
          v << "#{file}: privileged job #{jid} step #{s['name'].inspect} uses #{u} (allowed: checkout / download-artifact / upload-artifact#{jid == 'attest-provenance' ? ' / attest-build-provenance' : ''})"
        end
        next if s['name'] == MINISIGN_STEP && jid == 'sign-manifest'
        v << "#{file}: privileged job #{jid} step #{s['name'].inspect} runs installs, interpreters or downloaders" if strip_comments(s['run']).match?(PRIV_FORBIDDEN_RUN)
      end
    end
    dep = steps.any? { |s| strip_comments(s['run']).match?(DEP_RUN) || s['uses'].to_s.match?(DEP_USES) }
    secret_names = []
    walk(job) { |_p, str| secret_names.concat(secrets_in(str)) }
    if dep
      v << "#{file}: job #{jid} runs dependency code but has environment #{job['environment'].inspect}" if job['environment']
      v << "#{file}: job #{jid} runs dependency code but references secrets #{secret_names.uniq.join(',')}" unless secret_names.empty?
      write = (job['permissions'].is_a?(Hash) ? job['permissions'] : {}).select { |_, x| x == 'write' }.keys
      v << "#{file}: job #{jid} runs dependency code but has write permission #{write.join(',')}" unless write.empty?
    end
    v << "#{file}: job #{jid} references secrets #{secret_names.uniq.join(',')} without an environment" if !secret_names.empty? && !job['environment']
  end
end

def idx(steps, re)
  steps.index { |s| s['name'].to_s.match?(re) }
end

def check_release(file, wf, v)
  jobs = wf['jobs']
  expect = %w[preflight build-cli build-desktop sign-macos smoke-cli-macos sign-manifest attest-provenance publish-release]
  v << "#{file}: job set is #{jobs.keys.inspect}, expected #{expect.inspect}" unless jobs.keys.sort == expect.sort
  envs = { 'sign-macos' => 'release-signing', 'sign-manifest' => 'release-signing', 'publish-release' => 'release-publish' }
  jobs.each do |jid, job|
    v << "#{file}: job #{jid} environment #{job['environment'].inspect}, expected #{envs[jid].inspect}" if job['environment'] != envs[jid]
    steps = job['steps'] || []
    names = []
    steps.each { |s| walk(s) { |p, str| names.concat(secrets_in(str).map { |n| [s['name'], n] }) } }
    names.each do |sn, n|
      v << "#{file}: job #{jid} step #{sn.inspect}: APPLE secret outside sign-macos" if n.start_with?('APPLE_') && jid != 'sign-macos'
      v << "#{file}: job #{jid} step #{sn.inspect}: MINISIGN secret outside sign-manifest 'Sign manifest'" if n.start_with?('MINISIGN_') && !(jid == 'sign-manifest' && sn == 'Sign manifest')
      v << "#{file}: job #{jid} step #{sn.inspect}: unknown secret #{n}" unless n.start_with?('APPLE_', 'MINISIGN_')
    end
  end
  v << "#{file}: only 'Sign manifest' may hold both MINISIGN secrets" unless
    (jobs['sign-manifest']['steps'].find { |s| s['name'] == 'Sign manifest' } || {}).fetch('env', {}).keys.sort == %w[MINISIGN_PASSWORD MINISIGN_SECRET_KEY]

  # ── whole graph, no escape hatches
  EXPECT_NEEDS.each { |jid, n| v << "#{file}: job #{jid} needs #{Array(jobs[jid] && jobs[jid]['needs']).sort.inspect}, expected #{n.sort.inspect}" if jobs[jid] && Array(jobs[jid]['needs']).sort != n.sort }
  walk_keys = lambda do |node, path, &blk|
    case node
    when Hash then node.each { |k, val| blk.call(path + [k], val); walk_keys.call(val, path + [k], &blk) }
    when Array then node.each_with_index { |val, i| walk_keys.call(val, path + [i], &blk) }
    end
  end
  walk_keys.call(wf, [], &(proc { |pth, _val| v << "#{file}: continue-on-error at #{pth.join('.')} is forbidden" if pth.last == 'continue-on-error' }))
  jobs.each do |jid, job|
    v << "#{file}: job #{jid} has a job-level `if:` (forbidden: a skipped job must not let later jobs run)" if job.key?('if')
    (job['steps'] || []).each do |st|
      next unless st['if'].to_s.match?(/always\(\)|failure\(\)|cancelled\(\)|success\(\)/)
      v << "#{file}: job #{jid} step #{st['name'].inspect} has an if: with a status function (only #{CLEANUP_STEPS.inspect} in sign-macos)" unless jid == 'sign-macos' && CLEANUP_STEPS.include?(st['name'])
    end
    st0 = (job['steps'] || [])[0] || {}
    pf0 = jobs['preflight']['steps'][0]
    v << "#{file}: job #{jid} must start with the identical #{VALIDATE_STEP.inspect} step" unless jid == 'attest-provenance' || (st0['name'] == VALIDATE_STEP && st0['run'] == pf0['run'] && st0['env'] == pf0['env'])
  end
  # ── every run line of the secret / write jobs is on an allow-list
  JOB_SCRIPTS.each do |jid, scripts|
    (jobs[jid]['steps'] || []).each do |st|
      next if st['name'] == VALIDATE_STEP || (jid == 'sign-manifest' && st['name'] == MINISIGN_STEP)
      strip_comments(st['run']).lines.map(&:strip).reject(&:empty?).each do |ln|
        ok = RUN_COMMON.any? { |re| re.match?(ln) } ||
             (jid == 'publish-release' && RUN_PUBLISH_EXACT.include?(ln)) || (jid == 'sign-manifest' && RUN_MANIFEST_EXACT.include?(ln)) ||
             (m = ln.match(%r{\A(?:bash )?scripts/([A-Za-z0-9_.-]+)(?: #{ARGS})?\z})) && scripts.include?(m[1])
        v << "#{file}: #{jid} step #{st['name'].inspect}: run line not on the allow-list: #{ln}" unless ok
      end
    end
  end
  (jobs['attest-provenance']['steps'] || []).each { |st| v << "#{file}: attest-provenance step #{st['name'].inspect} must not run shell" if st.key?('run') }
  ms = jobs['sign-manifest']['steps']
  inst = ms.select { |st| st['name'] == MINISIGN_STEP }
  if inst.length != 1 || strip_comments(inst[0]['run']).lines.map(&:strip).reject(&:empty?) != MINISIGN_BODY || inst[0].key?('env') || inst[0].key?('uses')
    v << "#{file}: sign-manifest needs exactly one #{MINISIGN_STEP.inspect} step with the pinned sha256 body, no env"
  end
  ii = idx(ms, /\AInstall minisign/); si = idx(ms, /\ASign manifest\z/); bi = idx(ms, /\ABuild manifest\z/)
  v << "#{file}: sign-manifest order must be install minisign -> build manifest -> sign manifest" unless ii && bi && si && ii < bi && bi < si
  jobs.each_value do |job|
    (job['steps'] || []).each do |st|
      next unless st['uses'].to_s.start_with?('actions/upload-artifact@') && st.dig('with', 'name').to_s.start_with?('unsigned-')
      v << "#{file}: #{st.dig('with', 'name')} retention-days must be >= 7 (approval can come days later)" unless st.dig('with', 'retention-days').to_i >= 7
    end
  end

  # ── sign-macos: fresh runner, scripts from its own checkout only, installs nothing
  sm = jobs['sign-macos']; ss = sm['steps']
  v << "#{file}: sign-macos must run on macOS" unless sm['runs-on'].to_s.include?('macos')
  needs = Array(sm['needs'])
  v << "#{file}: sign-macos must need build-cli and build-desktop" unless (%w[build-cli build-desktop] - needs).empty?
  ss.each do |s|
    if s['uses'] && !s['uses'].match?(SIGN_ALLOWED_USES)
      v << "#{file}: sign-macos step #{s['name'].inspect} uses #{s['uses']} (only checkout / download-artifact / upload-artifact)"
    end
    body = strip_comments(s['run'])
    v << "#{file}: sign-macos step #{s['name'].inspect} installs or runs dependency tooling" if body.match?(SIGN_FORBIDDEN_RUN)
    body.scan(%r{(?:bash\s+)?scripts/([A-Za-z0-9_.-]+)}).flatten.each do |sc|
      v << "#{file}: sign-macos step #{s['name'].inspect} runs scripts/#{sc} (not in the allowed set)" unless SIGN_ALLOWED_SCRIPTS.include?(sc)
    end
  end
  ci = idx(ss, /\ACheckout\z/); dl = idx(ss, /\ADownload unsigned CLI/)
  v << "#{file}: sign-macos must check out before downloading artifacts" unless ci && dl && ci < dl
  ss.each do |s|
    next unless s['uses'].to_s.start_with?('actions/download-artifact@')
    v << "#{file}: sign-macos downloads #{s.dig('with', 'name').inspect} (must be unsigned-cli-/unsigned-desktop-<target>)" unless s.dig('with', 'name').to_s.match?(/\Aunsigned-(cli|desktop)-\$\{\{ matrix\.target \}\}\z/)
  end
  ups = ss.select { |s| s['uses'].to_s.start_with?('actions/upload-artifact@') }.map { |s| s.dig('with', 'name') }.sort
  v << "#{file}: sign-macos uploads #{ups.inspect}, expected cli-/desktop-${{ matrix.target }}" unless ups == ['cli-${{ matrix.target }}', 'desktop-${{ matrix.target }}']
  ss.each do |s|
    secs = []; walk(s) { |_p, str| secs.concat(secrets_in(str)) }
    next if secs.empty?
    n = s['name'].to_s
    if n == 'Detect Apple signing secrets'
      (s['env'] || {}).each do |k, val|
        next unless val.to_s.include?('secrets.')
        ok = k == 'APPLE_TEAM_ID' ? val.to_s.strip == '${{ secrets.APPLE_TEAM_ID }}' : val.to_s.match?(/\A\$\{\{ secrets\.#{k} != '' && 'present' \|\| '' \}\}\z/)
        v << "#{file}: Detect step env #{k} must be a presence test (placeholder), not the secret value" unless ok
      end
      next
    end
    pair = SIGN_STEP_SECRETS.find { |re, _| n.match?(re) }
    if pair.nil? then v << "#{file}: sign-macos step #{n.inspect} may not hold secrets"
    elsif secs.sort != pair[1].sort then v << "#{file}: sign-macos step #{n.inspect} holds #{secs.sort.inspect}, expected exactly #{pair[1].sort.inspect}"
    end
    v << "#{file}: sign-macos step #{n.inspect} (notarization) needs its own timeout-minutes" if (secs & KEY3).any? && !s['timeout-minutes'].is_a?(Integer)
  end
  # ordering: keychain only after unpack; signing order; lzma recompress BEFORE the dmg container is signed
  order = [/\AVerify and unpack unsigned data/, /\AImport signing certificate\z/, /\ASign macOS app /, /\ANotarize and staple macOS app\z/,
           /\APut signed app into dmg\z/, /\ARecompress dmg/, /\ASign, notarize and staple dmg container\z/, /\AVerify signed and notarized macOS bundle\z/, /\ARemove signing keychain\z/]
  pos = order.map { |re| idx(ss, re) }
  v << "#{file}: sign-macos step order is wrong or a step is missing (#{pos.inspect})" if pos.any?(&:nil?) || pos != pos.sort
  kc = ss.find { |s| s['name'] == 'Remove signing keychain' }
  v << "#{file}: 'Remove signing keychain' must run under always()" unless kc && kc['if'].to_s.include?('always()')

  # ── build jobs: unsigned data only; macOS never uploads a final name
  %w[build-cli build-desktop].each do |jid|
    jobs[jid]['steps'].each do |s|
      next unless s['uses'].to_s.start_with?('actions/upload-artifact@')
      nm = s.dig('with', 'name').to_s
      if nm.start_with?('unsigned-')
        v << "#{file}: #{jid} uploads #{nm} without an `if: runner.os == 'macOS'`" unless s['if'].to_s.include?("== 'macOS'")
      else
        v << "#{file}: #{jid} uploads #{nm} on macOS (final names come from sign-macos only)" unless s['if'].to_s.match?(/!= 'macOS'|== 'Linux'/)
      end
    end
    v << "#{file}: #{jid} must not touch the keychain or sign" if jobs[jid]['steps'].any? { |s| strip_comments(s['run']).match?(/macos-ci-sign|codesign|notarytool|keychain/) }
  end

  # ── sign-manifest: per-artifact directories only, collected by the mapping script
  mf = jobs['sign-manifest']['steps']
  dls = mf.select { |s| s['uses'].to_s.start_with?('actions/download-artifact@') }
  v << "#{file}: sign-manifest must download by pattern cli-* / desktop-* only" unless dls.map { |s| s.dig('with', 'pattern').to_s }.sort == %w[cli-* desktop-*]
  v << "#{file}: sign-manifest download must not merge artifacts" if dls.any? { |s| s.dig('with', 'merge-multiple') }
  ci = idx(mf, /\ACollect release assets\z/)
  v << "#{file}: sign-manifest must run scripts/collect-release-assets.sh" unless ci && mf[ci]['run'].to_s.include?('scripts/collect-release-assets.sh')
  v << "#{file}: sign-manifest must not flatten artifacts (find ... cp)" if mf.any? { |s| strip_comments(s['run']).match?(/find\s+downloaded-artifacts/) }

  # ── preflight: ancestry + not-already-published; publish: refuse a published release
  pf = jobs['preflight']['steps']
  co = pf.find { |s| s['uses'].to_s.start_with?('actions/checkout@') }
  v << "#{file}: preflight checkout needs fetch-depth: 0 (origin/main for the ancestry check)" unless co && co.dig('with', 'fetch-depth') == 0
  anc = pf.index { |s| s['run'].to_s.include?('scripts/check-commit-on-main.sh') && s['run'].to_s.include?('refs/remotes/origin/main') }
  v << "#{file}: preflight lacks the tagged-commit-on-main check" unless anc && anc > pf.index(co)
  v << "#{file}: preflight lacks the already-published check" unless pf.any? { |s| s['run'].to_s.include?('scripts/check-release-not-published.sh') }
  pub = jobs['publish-release']['steps']
  g = pub.index { |s| s['run'].to_s.include?('scripts/check-release-not-published.sh') }
  c = pub.index { |s| s['name'] == 'Create draft release and upload assets' }
  v << "#{file}: publish-release must refuse a published release BEFORE creating/updating it" unless g && c && g < c
  v << "#{file}: publish-release must create the release with `gh release create --verify-tag --draft`" unless c && pub[c]['run'].to_s.include?('--verify-tag') && pub[c]['run'].to_s.include?('--draft') && pub[c]['run'].to_s.include?('gh release create')
  v << "#{file}: publish-release must not use the release-signing environment" if jobs['publish-release']['environment'] == 'release-signing'

  v << "#{file}: release.yml must not use caches" if wf.to_yaml.match?(/actions\/cache|rust-cache|^\s*cache:/)
end

abort 'usage: check-workflow-policy.rb <workflow.yml>... (no files given: nothing was checked)' if ARGV.empty?
violations = []
ARGV.each do |f|
  raw = File.read(f, encoding: 'UTF-8')
  wf = YAML.safe_load(raw, aliases: false)
  check_generic(f, raw, wf, violations)
  check_release(f, wf, violations) if File.basename(f) == 'release.yml'
end
violations.each { |m| puts "VIOLATION #{m}" }
exit(violations.empty? ? 0 : 1)
