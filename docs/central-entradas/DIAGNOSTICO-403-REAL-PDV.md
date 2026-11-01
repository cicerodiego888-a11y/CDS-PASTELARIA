# Diagnóstico — 403 real na abertura do PDV Express

O PDV Express chegou a abrir na porta 3001 e os três GETs responderam 403. O trecho de console não inclui o JSON, então o `code` dessa resposta não ficou visível.

Inspeção em 31/10/2026. O processo iniciado por `npm start` foi deixado em execução. Nenhum código, banco, autenticação, licença ou permissão foi alterado. Nenhum token foi impresso. Não houve venda, TEF, PIX nem emissão fiscal. A porta 3218 não foi usada.

## 1. Preparação

- Diretório: `C:\projetos\CDS-SISTEMAS PASTELARIA`.
- A porta 3001 estava livre.
- `npm start` subiu o Electron. O log do backend registrou `Servidor rodando na porta 3001`.
- A porta 3001 passou a escutar. A janela do Electron abriu com o título `CDS Sistemas - Plataforma Inteligente de Gestão`.
- O painel Network não foi aberto daqui: o acesso à janela do Electron não ficou disponível. A captura abaixo é o console que o PDV imprimiu.

## 2. As três respostas

O relógio é o sufixo `_=` do jQuery, em UTC.

| Pedido | Status | Horário | `code` | Mensagem |
| --- | --- | --- | --- | --- |
| `GET /api/produtos?modo_fiscal=1&somente_vendaveis=1` | 403 | 2026-10-31T23:04:51.735Z | não veio no console | não veio no console |
| `GET /api/caixa/aberto?terminal_id=3` | 403 | 2026-10-31T23:04:51.732Z a .739Z, repetido | não veio no console | não veio no console |
| `GET /api/vendas/pdv-modelo-empresa` | 403 | 2026-10-31T23:04:51.734Z e de novo após recarregar o PDV | não veio no console | não veio no console |

O console registra `pdv.js:382 Erro ao carregar produtos: Object`. O objeto não foi expandido, então `responseJSON` não aparece. `pdv.js:366` imprime `Carregando PDV...` de novo e os três 403 se repetem. O caixa é chamado mais de uma vez porque o PDV consulta o caixa aberto outra vez depois de registrar o terminal.

`Authorization` e `X-Empresa-Id` não aparecem no texto colado. O valor deles não foi lido.

O que o código do PDV faz nesses GETs: `ajaxSetup` em `frontend/shared/js/core.js` envia `Authorization` quando existe `localStorage.token`, e `X-Empresa-Id` quando `cds_empresa_id` é um inteiro positivo. Sem `Authorization`, os três endereços respondem 401 `SESSAO_INVALIDA` com a mensagem `Acesso negado`. Isso foi conferido no servidor já em execução, às 23:08:10Z, sem enviar token. O console mostra 403, não 401. O pedido que falhou, portanto, levava `Authorization`.

## 3. O que não explica o 403

`GET /api/terminais/auto` está na lista pública de `backend/middleware/apiPublicPaths.js`. Ele não passa por autenticação nem por licença. A linha `Terminal PDV registrado` (`pdv.js:772`), com hostname `DESKTOP-4B8AMM3`, só prova que esse GET público funcionou. Não prova que o JWT dos outros três foi aceito.

## 4. Código real

Não confirmado no corpo da resposta. Não dá para fechar em `SESSAO_INVALIDA`, `LICENCA_AUSENTE`, `DATA_ALTERADA` ou `EMPRESA_NAO_AUTORIZADA` só com as linhas `Failed to load resource`.

O teste condicional de novo login não foi feito. Ele só caberia depois de ler `SESSAO_INVALIDA` no JSON, e esse campo não veio no console.

Conferência separada, sem imprimir token: no armazenamento local do Electron há sessões já vencidas antes das 23:04:51Z (a última delas expira em 2026-10-31T22:38:54Z) e sessões que ainda verificam. Uma sessão ainda válida, enviada com `Authorization` e `X-Empresa-Id`, recebeu 200 nos três GETs às 23:06:48Z. Essa repetição não é o pedido que o console marcou como 403. Ela mostra que um JWT ainda válido, com empresa no cabeçalho, passa nessas rotas. O 403 das 23:04:51Z usou outro estado de sessão, que o console não detalhou.

## 5. Limitação

Falta o JSON de um dos 403 do console, em especial `code` e `error` ou `erro` e `mensagem`. Ele está em `xhr.responseJSON` na linha `pdv.js:382`, ou na aba Network, na resposta do GET. Sem esse corpo, o vínculo empresarial também não foi consultado.

## 6. Correção aplicada

Nova abertura, por volta de 23:15:25Z, repetiu os três 403 e manteve o PDV na tela. `loadPDV` só roda depois que `POST /api/auth/verificar` responde sucesso. Esse POST passa pelo mesmo JWT e pela mesma licença. Se o token fosse inválido ou a licença recusasse a API, o shell iria para `/login` e o PDV não imprimiria `Carregando PDV...`. A mensagem de `EMPRESA_NAO_AUTORIZADA` não contém “token” nem “sessão”, então o PDV permanece na página e repete os GETs. Isso coincide com o console.

A checagem das rotas de produtos, vendas e caixa chamava `exigirEmpresaAutorizada` só com o id numérico. `administradorOperacional` ignora um número e exige linha em `usuario_empresas`. O seletor já entregava o objeto do usuário, então o ADMIN escolhia a empresa e os três GETs recusavam.

A correção passa `user: req.user` nessa checagem, também em pedidos, financeiro, bancário e MIS. Operador sem vínculo continua em 403. O teste `tests/central-entradas/cds-central-seletor-empresas-admin.test.js` ficou 6/6, em memória. O processo da porta 3001 já tinha encerrado; a correção entra no próximo `npm start`.
