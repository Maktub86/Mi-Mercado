Rem Lanza la revision de Mi Mercado sin abrir ninguna ventana.
Set shell = CreateObject("WScript.Shell")
carpeta = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
shell.Run """" & carpeta & "\actualizar.bat""", 0, True
