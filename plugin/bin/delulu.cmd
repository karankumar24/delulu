@echo off
:: The Windows half of `delulu`. Its POSIX twin lives beside it as `delulu` (no extension); the two
:: must stay in step, because every message this tool prints — "run `delulu resume <name>`" and the
:: eighteen others — is addressed to whoever is reading it, on whatever they are running.
::
:: Windows resolves a bare `delulu` on PATH by trying PATHEXT, which finds this file; the
:: extensionless sh script beside it is never a candidate, so the two cannot collide.
::
:: %~dp0 is this file's own directory WITH a trailing backslash, which is why the `..` follows with
:: no separator. The plugin lives in a versioned cache directory nobody can hardcode, so resolving
:: from self is the only thing that holds.
::
:: `call` is deliberate, though not for the usual reason. `node` is normally node.exe, where call
:: is a harmless no-op — but nvm-windows and Volta put a `node.cmd` SHIM on PATH, and a batch file
:: that invokes another batch file without `call` never returns to the caller. %ERRORLEVEL% is then
:: propagated by hand, because cmd does not do it for you and the dispatcher's exit code is
:: load-bearing: a run that wrote nothing must not report success.
setlocal
call node "%~dp0..\hook\cli.mjs" %*
exit /b %ERRORLEVEL%
