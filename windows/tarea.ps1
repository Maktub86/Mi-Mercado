# Crea (o actualiza) la tarea programada de Mi Mercado: cada día a las 22:00,
# y en cuanto se encienda el ordenador si a esa hora estaba apagado.
$carpeta = Join-Path $env:LOCALAPPDATA 'MiMercado'
$vbs = Join-Path $carpeta 'ejecutar_oculto.vbs'
# wscript + .vbs: la revisión se hace sin ninguna ventana que se pueda cerrar por error
$accion = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument "`"$vbs`"" -WorkingDirectory $carpeta
$cuando = New-ScheduledTaskTrigger -Daily -At '22:00'
$ajustes = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit (New-TimeSpan -Hours 1)
Register-ScheduledTask -TaskName 'Mi Mercado - revisar precios' -Action $accion -Trigger $cuando -Settings $ajustes `
  -Description 'Revisa los precios de Mi Mercado y los sube a la web' -Force | Out-Null
