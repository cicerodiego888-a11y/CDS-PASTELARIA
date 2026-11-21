# Histórico de Vendas: identidade e origem

## Campos auditáveis

`vendas.origem` mantém seu significado e valores existentes. A classificação mais específica de vendas novas fica em `origem_operacao` (`PDV_DESKTOP`, `PDV_MOBILE` ou a origem oficial do fluxo). O vendedor é vinculado por `operador_id`; `operador_nome_snapshot` preserva o nome cadastrado no momento da gravação. `terminal_id`, `terminal_tipo_snapshot`, `caixa_id` e `caixa_sessao_id` registram os vínculos operacionais disponíveis.

## Origem dos dados

- O canal `POST /api/vendas` é marcado pelo servidor. A origem Mobile só é gravada após validação da instalação e do terminal; os demais terminais PDV desse canal são classificados como Desktop.
- O vendedor é resolvido a partir da sessão autenticada e validado em `usuarios`. O nome vem do cadastro (`nome`, com `username` como identificador de exibição quando o nome não está preenchido); campos livres do payload não definem vendedor ou origem.
- Terminal, caixa e sessão usam os vínculos já validados pelos middlewares e pelo serviço de persistência.
- A listagem e o detalhe continuam limitados à empresa autorizada no contexto da requisição.

## Compatibilidade histórica

Os três campos novos são anuláveis, sem default ou preenchimento retroativo. A tabela mostra `MOBILE` somente para `PDV_MOBILE` e `DESKTOP` somente para `PDV_DESKTOP`; qualquer outro valor ou ausência de classificação recebe um indicador neutro, sem inferência a partir de `origem`.

Para vendas antigas sem `operador_nome_snapshot`, a consulta de leitura tenta `usuarios.nome` e depois `usuarios.username`. Esse fallback não altera a venda; se o usuário não existir ou não tiver identificação disponível, a interface mostra o ID quando houver.
