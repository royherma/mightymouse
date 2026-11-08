#!/usr/bin/env python3
"""Add or remove the Meta Wearables Toolkit (MWDAT) from the iOS target.

App Review asks for authorization documentation on third-party SDKs, and an
embedded framework counts even when no code calls it -- gating the Swift with
`#if MM_GLASSES` stops the SYMBOLS but leaves the framework inside the .app.
SPM products link per-target, not per-configuration, so the only way to ship a
Release build without the SDK is to detach the package from the target.

    ios/scripts/toggle-glasses-sdk.py off   # before an App Store build
    ios/scripts/toggle-glasses-sdk.py on    # to work on glasses again

Pair it with MM_GLASSES in SWIFT_ACTIVE_COMPILATION_CONDITIONS: `off` also drops
the flag, so GlassesSession.swift compiles to nothing and the build stays green.
"""
import re
import sys
from pathlib import Path

PBXPROJ = Path(__file__).resolve().parent.parent / "MightyMouse.xcodeproj" / "project.pbxproj"

# The three PBXBuildFile entries that put the products in the Frameworks phase.
BUILD_FILES = """\t\tA21000000000000000000001 /* MWDATCore in Frameworks */ = {isa = PBXBuildFile; productRef = A20000000000000000000001 /* MWDATCore */; };
\t\tA21000000000000000000002 /* MWDATCamera in Frameworks */ = {isa = PBXBuildFile; productRef = A20000000000000000000002 /* MWDATCamera */; };
\t\tA21000000000000000000003 /* MWDATMockDevice in Frameworks */ = {isa = PBXBuildFile; productRef = A20000000000000000000003 /* MWDATMockDevice */; };
"""

FRAMEWORKS_PHASE = """\t\t\t\tA21000000000000000000001 /* MWDATCore in Frameworks */,
\t\t\t\tA21000000000000000000002 /* MWDATCamera in Frameworks */,
\t\t\t\tA21000000000000000000003 /* MWDATMockDevice in Frameworks */,
"""

PACKAGE_PRODUCT_DEPS = """\t\t\tpackageProductDependencies = (
\t\t\t\tA20000000000000000000001 /* MWDATCore */,
\t\t\t\tA20000000000000000000002 /* MWDATCamera */,
\t\t\t\tA20000000000000000000003 /* MWDATMockDevice */,
\t\t\t);
"""

PACKAGE_REF = """\t\t\t\tA30000000000000000000001 /* XCRemoteSwiftPackageReference "meta-wearables-dat-ios" */,
"""

# The XCRemoteSwiftPackageReference + XCSwiftPackageProductDependency sections.
REMOTE_PKG_RE = re.compile(
    r"/\* Begin XCRemoteSwiftPackageReference section \*/.*?"
    r"/\* End XCSwiftPackageProductDependency section \*/\n",
    re.DOTALL,
)

SECTIONS = """/* Begin XCRemoteSwiftPackageReference section */
\t\tA30000000000000000000001 /* XCRemoteSwiftPackageReference "meta-wearables-dat-ios" */ = {
\t\t\tisa = XCRemoteSwiftPackageReference;
\t\t\trepositoryURL = "https://github.com/facebook/meta-wearables-dat-ios";
\t\t\trequirement = {
\t\t\t\tkind = upToNextMajorVersion;
\t\t\t\tminimumVersion = 0.9.0;
\t\t\t};
\t\t};
/* End XCRemoteSwiftPackageReference section */

/* Begin XCSwiftPackageProductDependency section */
\t\tA20000000000000000000001 /* MWDATCore */ = {
\t\t\tisa = XCSwiftPackageProductDependency;
\t\t\tpackage = A30000000000000000000001 /* XCRemoteSwiftPackageReference "meta-wearables-dat-ios" */;
\t\t\tproductName = MWDATCore;
\t\t};
\t\tA20000000000000000000002 /* MWDATCamera */ = {
\t\t\tisa = XCSwiftPackageProductDependency;
\t\t\tpackage = A30000000000000000000001 /* XCRemoteSwiftPackageReference "meta-wearables-dat-ios" */;
\t\t\tproductName = MWDATCamera;
\t\t};
\t\tA20000000000000000000003 /* MWDATMockDevice */ = {
\t\t\tisa = XCSwiftPackageProductDependency;
\t\t\tpackage = A30000000000000000000001 /* XCRemoteSwiftPackageReference "meta-wearables-dat-ios" */;
\t\t\tproductName = MWDATMockDevice;
\t\t};
/* End XCSwiftPackageProductDependency section */
"""

DEBUG_WITH = 'SWIFT_ACTIVE_COMPILATION_CONDITIONS = "DEBUG MM_GLASSES";'
DEBUG_WITHOUT = "SWIFT_ACTIVE_COMPILATION_CONDITIONS = DEBUG;"


def turn_off(text: str) -> str:
    text = text.replace(BUILD_FILES, "")
    text = text.replace(FRAMEWORKS_PHASE, "")
    text = text.replace(PACKAGE_PRODUCT_DEPS, "")
    text = text.replace("\t\t\tpackageReferences = (\n" + PACKAGE_REF + "\t\t\t);\n", "")
    text = REMOTE_PKG_RE.sub("", text)
    return text.replace(DEBUG_WITH, DEBUG_WITHOUT)


def turn_on(text: str) -> str:
    if "MWDATCore" in text:
        return text
    text = text.replace(
        "/* End PBXBuildFile section */", BUILD_FILES + "/* End PBXBuildFile section */"
    )
    text = text.replace(
        "\t\tC10000000000000000000001 /* Frameworks */ = {\n"
        "\t\t\tisa = PBXFrameworksBuildPhase;\n"
        "\t\t\tbuildActionMask = 2147483647;\n"
        "\t\t\tfiles = (\n",
        "\t\tC10000000000000000000001 /* Frameworks */ = {\n"
        "\t\t\tisa = PBXFrameworksBuildPhase;\n"
        "\t\t\tbuildActionMask = 2147483647;\n"
        "\t\t\tfiles = (\n" + FRAMEWORKS_PHASE,
    )
    text = text.replace(
        "\t\t\tname = MightyMouse;\n", "\t\t\tname = MightyMouse;\n" + PACKAGE_PRODUCT_DEPS, 1
    )
    text = text.replace(
        "\t\t\tproductRefGroup = D10000000000000000000003 /* Products */;\n",
        "\t\t\tpackageReferences = (\n"
        + PACKAGE_REF
        + "\t\t\t);\n"
        + "\t\t\tproductRefGroup = D10000000000000000000003 /* Products */;\n",
    )
    text = text.replace(
        "/* Begin XCBuildConfiguration section */", SECTIONS + "\n/* Begin XCBuildConfiguration section */"
    )
    return text.replace(DEBUG_WITHOUT, DEBUG_WITH)


def main() -> int:
    if len(sys.argv) != 2 or sys.argv[1] not in {"on", "off"}:
        print(__doc__)
        return 2
    text = PBXPROJ.read_text()
    updated = turn_on(text) if sys.argv[1] == "on" else turn_off(text)
    PBXPROJ.write_text(updated)
    present = "MWDATCore" in updated
    print(f"glasses SDK {'ON' if present else 'OFF'} -- {PBXPROJ.name} updated")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
