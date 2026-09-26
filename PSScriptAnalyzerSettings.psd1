# Settings for Invoke-ScriptAnalyzer over clients/ (CI: .github/workflows/ci.yml).
@{
  # The installers and the manual reporter talk to the person at the console:
  # coloured status lines are the point, not something to redirect.
  ExcludeRules = @('PSAvoidUsingWriteHost')
}
