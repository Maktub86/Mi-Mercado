# Crea (o actualiza) la tarea programada de Mi Mercado: cada día a las 22:00,
# y en cuanto se encienda el ordenador si a esa hora estaba apagado.
$carpeta = Join-Path $env:LOCALAPPDATA 'MiMercado'
$bat = Join-Path $carpeta 'actualizar.bat'
$accion = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument "/c start `"`" /min `"$bat`"" -WorkingDirectory $carpeta
$cuando = New-ScheduledTaskTrigger -Daily -At '22:00'
$ajustes = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit (New-TimeSpan -Hours 1)
Register-ScheduledTask -TaskName 'Mi Mercado - revisar precios' -Action $accion -Trigger $cuando -Settings $ajustes `
  -Description 'Revisa los precios de Mi Mercado y los sube a la web' -Force | Out-Null
