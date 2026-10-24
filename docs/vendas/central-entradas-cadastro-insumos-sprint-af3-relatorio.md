# Sprint A-F3 — Cadastro e roteamento de INSUMO na Central de Entradas

**Projeto:** CDS Sistemas — Pastelaria  
**Escopo:** preservar a classificação operacional explícita de cada item ao abrir o modal de cadastro.  
**Resultado:** correção implementada; testes automatizados executados em banco temporário ou SQLite em memória. Validação visual pendente por bloqueio HTTP 403.

## 1. Diagnóstico do fluxo anterior

O modal compartilhado `showProdutoModal` determinava o tipo operacional somente pela página ativa (`insumos` ou `produtos`). Em Compras/MIIP, sem página que forçasse um tipo, a opção `COMERCIAL` era selecionada para cadastro novo.

O fluxo MIIP da Central abria o modal chamando `showProdutoModal` sem incluir `tipo_operacional`, mesmo quando o item de contexto continha uma classificação explícita. O caminho de cadastro iniciado a partir de um item de Compra também não encaminhava o tipo para o modal. Por isso, uma classificação já escolhida não chegava ao estado inicial do formulário.

O backend de produtos já aceita e persiste `tipo_operacional`, rejeita tipos inválidos e zera preço de venda/markup para INSUMO. A rota de Compras da Central também cria explicitamente cada produto dentro da transação com o tipo do item. Nenhum serviço operacional do backend precisou ser alterado.

### Fluxo depois da correção

1. O contexto MIIP ou o item da Compra encaminha `tipo_operacional` somente quando ele está explicitamente definido; na montagem do item MIIP, a escolha da sessão tem precedência sobre o payload XML.
2. O modal valida o valor recebido, seleciona e bloqueia esse tipo para aquela criação, evitando divergência entre o item e o cadastro.
3. Cada abertura calcula o tipo em escopo local e renderiza um modal novo; não reutiliza a escolha de uma abertura anterior.
4. Sem classificação explícita, mantém-se o comportamento legado: COMERCIAL por padrão, sem inferência pelo nome, unidade, embalagem, código ou fornecedor.
5. O `saveProduto` existente lê o seletor e envia o tipo no payload. Para INSUMO, mantém venda e markup em zero; o backend persiste a classificação validada.

## 2. Arquivos alterados

- `frontend/erp/js/produtos.js` — valida o tipo explícito recebido, prioriza-o no formulário de criação e usa-o na seleção inicial; mantém o tipo bloqueado durante aquela criação.
- `frontend/erp/js/compras.js` — encaminha ao modal o tipo explícito do item da Compra e o preserva no contexto do retorno.
- `frontend/erp/js/miip-central-revisao.js` — encaminha ao modal somente o tipo operacional existente no item da revisão.
- `tests/compras/rc43127-retorno-cadastro-produto-compra.test.js` — adiciona verificações de contrato do roteamento Central/Compra, prioridade e seleção do tipo, rejeição de tipo inválido no modal e retorno após cancelamento.
- `tests/pastelaria/insumo-sem-preco-venda.test.js` — acrescenta verificações de rejeição HTTP para tipo inválido e ausência de ficha técnica criada automaticamente para INSUMO.
- Este relatório — diagnóstico, limites e resultados da Sprint A-F3.

## 3. Classificação, payload e persistência

- **INSUMO:** o tipo explícito recebido é selecionado no modal; o payload existente envia `tipo_operacional: INSUMO`; a rota existente persiste `INSUMO` e mantém `preco_venda` e `lucro_percentual` em zero.
- **COMERCIAL:** o tipo explícito recebido é selecionado no modal; o payload envia `COMERCIAL`; o comportamento comercial existente de preço e markup foi exercitado sem alteração.
- **Valor inválido:** a abertura do modal não prossegue com um tipo explícito inválido; a rota de produtos também rejeita esse valor com HTTP 400 e `TIPO_OPERACIONAL_INVALIDO`.
- **Sem tipo no contexto:** preserva-se o default comercial legado. Isso não classifica automaticamente o item da NF-e: para obter INSUMO, o fluxo precisa trazer a escolha explícita do operador.
- **Cancelamento/reabertura:** o cancelamento continua sem adicionar produto à Compra; uma nova abertura renderiza o tipo a partir do novo contexto, sem estado global de tipo.
- **Nota mista e divergência:** os testes de Compras continuam cobrindo itens COMERCIAL e INSUMO juntos e rejeição de vínculo com classificação divergente, sem reclassificar produtos existentes.

## 4. Testes executados

| Comando | Resultado |
|---|---|
| `node tests/compras/rc43127-retorno-cadastro-produto-compra.test.js` | **14 OK, 0 falhas.** Verificações de contrato do modal/retorno e encaminhamento da classificação. |
| `node tests/compras/classificacao-itens-nfe-compra.test.js` | **15 OK, 0 falhas.** Banco temporário; inclui compra mista, criação de INSUMO/COMERCIAL, persistência, classificação ausente, divergência, conversões e idempotência. |
| `node tests/pastelaria/insumo-sem-preco-venda.test.js` | **Passou** com banco temporário. Verificou criação/persistência de INSUMO, venda/markup zerados, preço comercial preservado, rejeição de tipo inválido e nenhuma ficha criada automaticamente para INSUMO. |
| `node tests/pastelaria/separacao-produtos-insumos.test.js` | **Passou** com SQLite em memória; verificou ficha somente para COMERCIAL e bloqueio da ficha para INSUMO. |
| `node tests/pastelaria/consumo-ficha-tecnica-venda-03-04.test.js` | **35/35 passaram** com SQLite em memória; regressão do fluxo de ficha técnica/consumo, conversão, isolamento por empresa e ausência de baixa duplicada. |
| `node --check frontend/erp/js/produtos.js` | **Passou.** |
| `node --check frontend/erp/js/compras.js` | **Passou.** |
| `node --check frontend/erp/js/miip-central-revisao.js` | **Passou.** |
| `node --check tests/compras/rc43127-retorno-cadastro-produto-compra.test.js` | **Passou.** |
| `node --check tests/pastelaria/insumo-sem-preco-venda.test.js` | **Passou.** |
| `git diff --check` | **Passou.** Git emitiu apenas aviso de normalização CRLF/LF preexistente em `backend/server.js`, fora do escopo. |

Os testes da interface verificam o contrato de encaminhamento por inspeção do código, não uma interação real no DOM. Os testes de backend verificam persistência e rejeição em banco isolado. Não se declara teste visual como aprovado.

## 5. Validação visual

**Pendente.** O ambiente ERP compartilhado já havia respondido HTTP 403 no trabalho anterior de validação da Central. Não foi possível abrir o fluxo autorizado no navegador nesta etapa. Não houve tentativa de contornar licença, autenticação ou permissão. Portanto, não foram visualmente confirmados o estado do seletor, a nota mista ou o retorno após cancelamento.

## 6. Regras preservadas, riscos e pendências

- A alteração não toca no parser fiscal, composição fiscal de refrigerantes, saldo fiscal, MUC, conversão de estoque, Pedido, ficha técnica operacional ou baixa física.
- Os testes executados não constituem uma validação visual da composição fiscal específica de refrigerantes. Esse cenário permanece sem confirmação visual nesta sprint.
- A revisão MIIP só consegue pré-selecionar INSUMO se a classificação explícita estiver presente no objeto do item; itens sem esse dado mantêm o default legado. Nenhuma classificação é inferida do conteúdo fiscal.
- O modal bloqueia a classificação recebida durante a criação para manter item e cadastro consistentes. Para trocar a classificação, o operador deve voltar ao item, corrigir a escolha explícita e abrir o cadastro novamente.
- Persistem como pendentes os cenários visuais reais de modal, edição/cancelamento/reabertura no navegador e nota mista.

## 7. Preservação e proteções

- `frontend/erp/js/produtos.js` e `frontend/erp/js/compras.js` já continham alterações locais antes desta sprint. Foram lidos e alterados cirurgicamente nos trechos relacionados, sem descartar ou reorganizar o restante.
- Outros arquivos modificados ou não rastreados do workspace foram preservados.
- Os testes de persistência utilizaram diretórios temporários ou SQLite em memória. **O banco oficial `C:\ProgramData\MercantilFiscal\dados` não foi acessado, aberto, migrado nem alterado.**
- **Nenhuma operação real na SEFAZ foi executada.**
- **Não foram executados commit, push, merge, reset, rebase ou rollback destrutivo.**
- A Sprint B não foi iniciada.

**Conclusão:** o encaminhamento da classificação explícita ao modal está corrigido e as regressões automatizadas listadas passaram. A Sprint A-F3 permanece parcialmente pendente até revisão e validação visual em ambiente autorizado.
