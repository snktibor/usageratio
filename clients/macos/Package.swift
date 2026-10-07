// swift-tools-version: 6.0
import PackageDescription

// The usageratio menu bar app: the weekly (or monthly) usage percentage in the
// macOS menu bar, read from GET /api/status. No dependencies beyond the SDK.
// Build: scripts/build-app.sh · Test: scripts/test.sh (see README.md).
let package = Package(
    name: "UsageRatioBar",
    platforms: [.macOS(.v14)],
    targets: [
        // Everything testable without AppKit: the payload, the API call, the wording.
        .target(name: "UsageRatioCore"),
        .executableTarget(name: "UsageRatioBar", dependencies: ["UsageRatioCore"]),
        .testTarget(name: "UsageRatioCoreTests", dependencies: ["UsageRatioCore"]),
    ]
)
