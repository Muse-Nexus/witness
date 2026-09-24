#!/usr/bin/env bash
# Builds Witness.app (the menu-bar app) and a disk image, from apps/mac.
#
#   scripts/build-app.sh                    lint, build, sign, and package the DMG
#   scripts/build-app.sh --lint             only check App/Info.plist and App/Witness.entitlements
#   scripts/build-app.sh --no-dmg           stop after signing Witness.app
#   scripts/build-app.sh --notarize <name>  also notarize and staple with a notarytool
#                                           keychain profile that is already stored
#                                           (or set WITNESS_NOTARY_PROFILE)
#
# Output: .build/Witness.app and .build/Witness-<version>.dmg (with an Applications link).
#
# Signing: the "Developer ID Application" identity for team KT5VZW5S7K in the login
# keychain, when there is one (WITNESS_TEAM_ID picks another team, WITNESS_SIGN_IDENTITY a
# specific identity). Without one the app is signed ad hoc, which runs on this Mac only,
# and the script says so. Hardened runtime, not sandboxed: Full Disk Access is granted to
# this exact app, and the App Sandbox would not allow reading Messages.
#
# This script never asks for, prints or stores a password. Notarization uses only a
# profile saved earlier with `xcrun notarytool store-credentials`.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
mac_dir="$(cd "$here/.." && pwd)"
repo_dir="$(cd "$mac_dir/../.." && pwd)"
info_plist="$mac_dir/App/Info.plist"
entitlements="$mac_dir/App/Witness.entitlements"
lexicon="$repo_dir/packages/detector/lexicon.json"
bundle_id="studio.musenexus.witness.mac"
team_id="${WITNESS_TEAM_ID:-KT5VZW5S7K}"
version="$(sed -n 's/.*public static let current = "\(.*\)".*/\1/p' "$mac_dir/Sources/WitnessMacCore/MessageScanner.swift")"
out_dir="$mac_dir/.build"
app="$out_dir/Witness.app"
dmg="$out_dir/Witness-$version.dmg"

lint_only=false
make_dmg=true
notary_profile="${WITNESS_NOTARY_PROFILE:-}"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --lint) lint_only=true ;;
    --no-dmg) make_dmg=false ;;
    --notarize)
      [[ $# -ge 2 ]] || { echo "--notarize needs a keychain profile name." >&2; exit 64; }
      notary_profile="$2"
      shift
      ;;
    -h|--help) sed -n '2,21p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option $1. Try --help." >&2; exit 64 ;;
  esac
  shift
done

step() { printf '\n▍%s\n' "$1"; }
fail() { printf '%s\n' "$1" >&2; exit 1; }

# A binary meant for other Macs must not carry the builder's folders: the debug map
# (object file paths) and any #filePath would name the builder's user and checkout.
# Searches every byte (`strings` skips the symbol table) and the debug map itself.
check_no_local_paths() { # binary
  local found
  found="$(
    {
      LC_ALL=C grep -a -o -E '/(Users|home)/[[:print:]]{1,80}' "$1" || true
      LC_ALL=C grep -a -o -F "$repo_dir" "$1" || true
      nm -ap "$1" 2>/dev/null | grep ' OSO ' || true
    } | sort -u | head -5
  )"
  if [[ -n "$found" ]]; then
    printf '  %s\n' "$found" >&2
    fail "$(basename "$1") still contains paths from this Mac. Nothing was signed."
  fi
  echo "No local paths in $(basename "$1")."
}

plist_value() { /usr/libexec/PlistBuddy -c "Print :$2" "$1" 2>/dev/null || true; }

# --- Lint --------------------------------------------------------------------------

lint() {
  plutil -lint -s "$info_plist" "$entitlements" || fail "Info.plist or the entitlements are not valid property lists."
  local problems=()
  expect() { # file key expected
    local actual
    actual="$(plist_value "$1" "$2")"
    [[ "$actual" == "$3" ]] || problems+=("$(basename "$1") $2 is '$actual', expected '$3'")
  }
  expect "$info_plist" CFBundleIdentifier "$bundle_id"
  expect "$info_plist" CFBundleExecutable "Witness"
  expect "$info_plist" CFBundleName "Witness"
  expect "$info_plist" CFBundlePackageType "APPL"
  expect "$info_plist" CFBundleShortVersionString "$version"
  expect "$info_plist" CFBundleIconFile "AppIcon"
  expect "$info_plist" LSMinimumSystemVersion "14.0"
  expect "$info_plist" LSUIElement "true"

  local contacts
  contacts="$(plist_value "$info_plist" NSContactsUsageDescription)"
  [[ -n "$contacts" ]] || problems+=("Info.plist needs NSContactsUsageDescription (names are optional, but macOS requires the reason)")
  [[ "$contacts" != *"!"* ]] || problems+=("NSContactsUsageDescription has an exclamation mark; product copy never does")
  # Photos favorites and screenshots are M3. Until they ship, the app does not ask for Photos.
  [[ -z "$(plist_value "$info_plist" NSPhotoLibraryUsageDescription)" ]] \
    || problems+=("Info.plist asks for Photos, which this version does not use")

  [[ -z "$(plist_value "$entitlements" com.apple.security.app-sandbox)" ]] \
    || problems+=("The app must not be sandboxed: Full Disk Access for Messages needs this exact, unsandboxed app")
  expect "$entitlements" com.apple.security.personal-information.addressbook "true"
  [[ -z "$(plist_value "$entitlements" com.apple.security.get-task-allow)" ]] \
    || problems+=("get-task-allow must not ship")

  if [[ ${#problems[@]} -gt 0 ]]; then
    printf '  %s\n' "${problems[@]}" >&2
    fail "Lint failed."
  fi
  echo "Info.plist and entitlements look right (version $version, $bundle_id)."
}

step "Lint"
[[ -n "$version" ]] || fail "Could not read WitnessMacVersion.current."
lint
$lint_only && exit 0

# --- Build -------------------------------------------------------------------------

step "Build (release)"
[[ -f "$lexicon" ]] || fail "Missing $lexicon"
cd "$mac_dir"
build_flags=(-c release --product WitnessMenuBar)
if swift build "${build_flags[@]}" --arch arm64 --arch x86_64; then
  bin_path="$(swift build "${build_flags[@]}" --arch arm64 --arch x86_64 --show-bin-path)"
else
  echo "A universal build did not work here; building for this Mac only."
  swift build "${build_flags[@]}"
  bin_path="$(swift build "${build_flags[@]}" --show-bin-path)"
fi
binary="$bin_path/WitnessMenuBar"
[[ -x "$binary" ]] || fail "No binary at $binary"

step "Assemble Witness.app"
rm -rf "$app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
cp "$binary" "$app/Contents/MacOS/Witness"
# Drop debug symbols and local symbols (with them, the debug map of object-file paths).
strip -S -x "$app/Contents/MacOS/Witness"
check_no_local_paths "$app/Contents/MacOS/Witness"
cp "$info_plist" "$app/Contents/Info.plist"
build_number="$(git -C "$repo_dir" rev-list --count HEAD 2>/dev/null || echo 1)"
/usr/libexec/PlistBuddy -c "Set :CFBundleVersion $build_number" "$app/Contents/Info.plist"
printf 'APPL????' > "$app/Contents/PkgInfo"
cp "$lexicon" "$app/Contents/Resources/lexicon.json"

work="$(mktemp -d "${TMPDIR:-/tmp}/witness-app.XXXXXX")"
trap 'rm -rf "$work"' EXIT
swift "$here/make-icon.swift" "$work/AppIcon.iconset" >/dev/null
iconutil -c icns -o "$app/Contents/Resources/AppIcon.icns" "$work/AppIcon.iconset"
plutil -lint -s "$app/Contents/Info.plist"
echo "Version $version ($build_number), $(lipo -archs "$app/Contents/MacOS/Witness")"

# --- Sign --------------------------------------------------------------------------

step "Sign"
identity="${WITNESS_SIGN_IDENTITY:-}"
if [[ -z "$identity" ]]; then
  identity="$(security find-identity -v -p codesigning 2>/dev/null \
    | awk -v team="($team_id)" '/Developer ID Application/ && index($0, team) { print $2; exit }')"
fi
if [[ -n "$identity" ]]; then
  identity_name="$(security find-identity -v -p codesigning 2>/dev/null | awk -v id="$identity" '$2 == id { $1 = ""; $2 = ""; sub(/^  /, ""); print; exit }')"
  echo "Signing with ${identity_name:-$identity}"
  codesign --force --timestamp --options runtime --entitlements "$entitlements" --sign "$identity" "$app"
  signed_with="developer-id"
else
  echo "No Developer ID Application identity for team $team_id in the keychain."
  echo "Signing ad hoc: this build runs on this Mac only, and cannot be notarized."
  codesign --force --options runtime --entitlements "$entitlements" --sign - "$app"
  signed_with="ad-hoc"
fi
codesign --verify --strict --deep --verbose=2 "$app"
codesign --display --verbose=2 "$app" 2>&1 | grep -E '^(Identifier|Authority|TeamIdentifier|Timestamp|Runtime Version|CodeDirectory)' || true

$make_dmg || { echo "Built $app ($signed_with)."; exit 0; }

# --- Disk image --------------------------------------------------------------------

step "Disk image"
staging="$work/dmg"
mkdir -p "$staging"
cp -R "$app" "$staging/"
ln -s /Applications "$staging/Applications"
rm -f "$dmg"
hdiutil create -quiet -volname "Witness" -srcfolder "$staging" -fs HFS+ -format UDZO -ov "$dmg"
if [[ "$signed_with" == "developer-id" ]]; then
  codesign --force --timestamp --sign "$identity" "$dmg"
  codesign --verify --verbose=2 "$dmg"
fi
hdiutil verify -quiet "$dmg"
(cd "$out_dir" && shasum -a 256 "$(basename "$dmg")" > "$(basename "$dmg").sha256")
echo "Built $dmg ($signed_with)"
cat "$dmg.sha256"

# --- Notarize (only with a stored profile) -----------------------------------------

if [[ -z "$notary_profile" ]]; then
  echo
  echo "Not notarized. To notarize, store a notarytool profile once (it asks for the"
  echo "credentials itself), then run: scripts/build-app.sh --notarize <profile>"
  exit 0
fi
[[ "$signed_with" == "developer-id" ]] || fail "Only a Developer ID build can be notarized."

step "Notarize"
result="$out_dir/notarization-result.json"
log="$out_dir/notarization-log.json"
if ! xcrun notarytool submit "$dmg" --keychain-profile "$notary_profile" --wait --output-format json > "$result"; then
  echo "Submission did not finish. Details: $result" >&2
fi
submission_id="$(plutil -extract id raw -o - "$result" 2>/dev/null || true)"
status="$(plutil -extract status raw -o - "$result" 2>/dev/null || true)"
[[ -n "$submission_id" ]] || fail "Apple did not return a submission id. See $result"
echo "Submission $submission_id: $status"
xcrun notarytool log "$submission_id" --keychain-profile "$notary_profile" "$log" >/dev/null || true
[[ "$status" == "Accepted" ]] || fail "Notarization was not accepted. See $log"

step "Staple and check"
xcrun stapler staple "$dmg"
xcrun stapler validate "$dmg"
xcrun stapler staple "$app" || echo "Could not staple the app folder; the disk image carries the ticket."
spctl --assess -vv --type install "$dmg"
spctl --assess -vv --type execute "$app"
(cd "$out_dir" && shasum -a 256 "$(basename "$dmg")" > "$(basename "$dmg").sha256")
echo "Notarized and stapled: $dmg (submission $submission_id)"
cat "$dmg.sha256"
