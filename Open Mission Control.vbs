' Windows launcher — double-click to use.
' Starts the Mission Control server from this folder (no-op if already running)
' and opens the dashboard in your default browser. Portable: resolves its own
' folder, so it works wherever you put the repo.
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
appDir = fso.GetParentFolderName(WScript.ScriptFullName)
shell.Run "cmd /c cd /d """ & appDir & """ && node server.js", 0, False
WScript.Sleep 1200
' Open the default browser. (Chrome users who want an app-style window: see SETUP.md.)
shell.Run "cmd /c start """" ""http://127.0.0.1:5599""", 0, False
