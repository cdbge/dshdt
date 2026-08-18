' Launch run.cmd hidden (used by Desktop/Start-Menu shortcuts)
Set sh = CreateObject("WScript.Shell")
sh.Run """" & Replace(WScript.ScriptFullName, "launch-hidden.vbs", "run.cmd") & """", 0, False
