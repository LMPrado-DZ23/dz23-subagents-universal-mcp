# Instalação por Hermes ou outro agente

Abra [HERMES_SELF_INSTALL_PROMPT.txt](../HERMES_SELF_INSTALL_PROMPT.txt) no computador
alvo, informe a pasta extraída e conceda apenas as permissões necessárias.
O agente deve ler os arquivos antes de executar, preservar configurações existentes,
validar o MCP local e separar teste de protocolo de teste real das APIs.

Um agente sem terminal/registro MCP não pode instalar a si próprio só por receber
um prompt. Nesse caso a ação depende do operador/host e deve ser declarada bloqueada.
Para publicar no GitHub use o prompt separado PUBLICAR_COM_HARNESS.txt.
