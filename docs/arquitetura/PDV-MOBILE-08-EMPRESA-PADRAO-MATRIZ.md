# PDV-MOBILE-08 — Empresa padrão da loja (matriz)

## 1. Causa raiz

O backend responde `empresaId é obrigatório` quando a operação exige contexto e o pedido chega sem `X-Empresa-Id`. O Mobile lia `cds_empresa_id` do navegador e, depois do login, esse valor está vazio: o login oficial limpa a empresa da sessão anterior.

O Pedido só escolhia empresa sozinho quando a lista autorizada tinha um único item, e nesse caso usava o primeiro registro. Com mais de uma empresa, abria uma escolha manual. O PDV não escolhia nenhuma. Pesquisa, preço, pedido, venda por valor, TEF, recomposição e fechamento saíam sem empresa.

Não havia ID fixo no JavaScript. Faltava a resolução da empresa padrão da loja.

## 2. Origem real da empresa padrão

Duas configurações oficiais, já usadas pelo Desktop:

| Situação | Origem | O que identifica a empresa |
|---|---|---|
| PDV em modo `UNICA` | `configuracoes.json`, campos `pdv_modelo_empresa` e `pdv_empresa_id`, lidos por `PdvModeloEmpresaService` | A empresa configurada para o caixa. O Desktop aplica isso em `alinharContextoPdvModeloEmpresa`. |
| Demais modos | Tabela `empresas`. Matriz é o CNPJ cuja ordem (posições 9 a 12) é `0001`, função `classificarTipoEmpresa` / `escolherMatrizPadrao` | Uma matriz ativa. Se houver mais de uma, o desempate é `empresa_operacional_id`. Sem desempate, o estado é `MATRIZ_AMBIGUA`. |

Empresa ativa é `empresas.ativo = 1`. Empresa autorizada é o vínculo ativo em `usuario_empresas`, conferido por `exigirEmpresaAutorizada`. Administrador operacional continua enxergando as empresas ativas por essa regra já existente. O seletor do ERP não foi alterado: `empresaPadrao` da barra lateral permanece como estava.

## 3. Desktop × Mobile

O Desktop, no ERP, chama `CdsEmpresaContexto.inicializar` e marca `matriz_padrao` na lista do operador. No PDV, se o modelo é `UNICA`, troca o contexto para `pdv_empresa_id`.

O Mobile não executava nenhum dos dois passos. Pedido e PDV passaram a chamar o mesmo `adotarEmpresaPadrao`, que grava a empresa em `cds_empresa_id` e `cds_empresa`. As chamadas seguintes usam `headersJson`, inclusive pesquisa de produto, cotação, venda por valor, composição sequencial, acompanhamento e `POST /api/vendas`.

O backend não aceita o cabeçalho como prova. `GET /api/empresas/contexto/padrao` resolve a padrão no servidor, valida atividade e autorização e só então devolve a empresa. Uma empresa não autorizada continua recusada nas rotas que já exigem contexto.

## 4. Arquivos e endpoint

Alterados:

- `backend/services/empresas/EmpresaService.js` — `resolverEmpresaPadraoDaLoja`
- `backend/rotas/empresas.js` — `GET /api/empresas/contexto/padrao`
- `frontend/shared/js/cds-empresa-contexto.js` — `adotarEmpresaPadrao`
- `frontend/mobile/mobile-inicio.js` — adota a padrão depois da licença e esconde PEDIDO e PDV se a padrão não puder ser usada
- `frontend/mobile-pedido/mobile-pedido.js` — deixa de usar o primeiro item da lista
- `frontend/mobile-pdv/mobile-pdv.js` — adota a mesma empresa ao abrir

Criados:

- `tests/mobile-pdv/pdv-mobile-08.test.js`
- este relatório

Códigos novos, sem escolher outro CNPJ:

| Código | Quando |
|---|---|
| `EMPRESA_PADRAO_NAO_AUTORIZADA` | O operador não tem vínculo com a padrão |
| `EMPRESA_PADRAO_INATIVA` | A matriz única, ou a empresa do PDV único, está inativa |
| `EMPRESA_PADRAO_AUSENTE` | Não há matriz ativa nem empresa única ativa |
| `MATRIZ_AMBIGUA` | Mais de uma matriz ativa e a configuração não desempata |

## 5. Testes

`node --test --test-concurrency=1`, um arquivo por vez. Banco `cds-mobpdv08` em `%TEMP%`. O caminho oficial `ProgramData\MercantilFiscal` não foi aberto. A configuração de empresas do repositório não foi gravada. Não houve TEF real nem SEFAZ.

| Caso | Resultado |
|---|---|
| Operador autorizado à matriz e à filial | `GET /contexto/padrao` devolve a matriz, origem `MATRIZ_CNPJ_0001`, não a filial |
| Operador só da filial | 403 `EMPRESA_PADRAO_NAO_AUTORIZADA`, sem corpo de outra empresa e sem o CNPJ da filial |
| Adoção no navegador | `X-Empresa-Id` fica com o id da matriz; `GET /contexto` com esse cabeçalho confirma a matriz; sem cabeçalho a seleção fica vazia |
| PDV `UNICA` apontando para a matriz | Operador sem vínculo é recusado; operador autorizado recebe a matriz, origem `CONFIG_PDV_EMPRESA_UNICA` |
| Matriz inativa, filial ativa | 400 `EMPRESA_PADRAO_INATIVA` |
| Nenhuma matriz | 409 `EMPRESA_PADRAO_AUSENTE` |

Pedido e PDV usam essa adoção antes de pesquisar produto, cotar preço, preparar venda, vender por valor, acompanhar pagamento, recompor e fechar. Esses passos continuam nos serviços já testados nas sprints 02 a 07; o que faltava era o `empresaId`. Esta sprint não reexecutou uma venda com catálogo: o banco temporário não tem produtos nem licença, e a licença do servidor completo não foi contornada.

Regressão no mesmo modo sequencial:

| Arquivo | Resultado |
|---|---|
| `pdv-mobile-02.test.js` | 14 passou |
| `pdv-mobile-03.test.js` | 13 passou |
| `pdv-mobile-04.test.js` | 7 passou |
| `pdv-mobile-05.test.js` | 12 passou |
| `pdv-mobile-06.test.js` | 2 passou |
| `pdv-mobile-07.test.js` | 16 passou |
| `pdv-mobile-08.test.js` | 6 passou |

## 6. Classificação

| Item | Estado |
|---|---|
| Diagnóstico do `empresaId obrigatório` | CONCLUÍDO |
| Resolução da matriz e do PDV em empresa única | CONCLUÍDO e testado |
| Pedido e PDV no mesmo contexto | CONCLUÍDO e testado |
| Operador sem autorização à matriz | CONCLUÍDO e testado |
| Padrão ausente ou inativa, sem fallback de CNPJ | CONCLUÍDO e testado |
| Pesquisa, carrinho, venda por valor e fechamento com catálogo no aparelho | Depende de licença válida no servidor em uso. A licença não foi copiada nem desligada |
