with import <nixpkgs> {};
mkShell {
  packages = [
    python311
    python311Packages.requests
  ];
}
