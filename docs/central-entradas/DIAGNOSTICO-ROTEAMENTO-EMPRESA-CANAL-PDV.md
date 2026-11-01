# Diagnóstico — roteamento de empresa por canal de venda

Leitura de 31/10/2026. Nenhum código, vínculo, configuração ou banco foi alterado. Nenhuma venda, TEF, PIX ou emissão foi executada.

## Causa comprovada

O bloqueio de pagamento do PDV não vem de divergência entre empresa, canal e configuração de pagamento. A configuração de pagamento é única na instalação, não está ligada a nenhuma empresa, e o TEF está desligado. O PDV físico, no fechamento, usa a empresa 1, que é a única matriz ativa.

Há outra divergência, e ela não participa desse bloqueio: `empresa_operacional_id` aponta para a filial 2, enquanto o canal PDV está fixo na matriz. Não existe tabela nem regra de canal iFood.

## 1. Empresa configurada para o PDV físico

Em `configuracoes.json`:

- `modo_operacional_global` = `MULTIEMPRESA`
- `pdv_modelo_empresa` = `UNICA`
- `pdv_empresa_id` = 1
- `empresa_operacional_id` = 2

`POST /api/vendas` passa por `aplicarModeloEmpresaPdvNaRequisicao`. Com modelo `UNICA` e origem efetiva PDV, o servidor grava a empresa de `pdv_empresa_id` e ignora o corpo e o `X-Empresa-Id`. O id 1 não está escrito no código; sai do arquivo de configuração.

A empresa 1 é a única ativa cuja ordem do CNPJ (posições 9–12) é `0001`. O nome fantasia é `PASTELARIA DO CHEFF - Matriz`. `escolherMatrizPadrao` a classifica como matriz.

## 2. Empresa usada no contexto da venda

No modo `MULTIEMPRESA`, `PoliticaMultiempresa.resolverEmpresaOperacionalContrato` devolve nulo. O campo `empresa_operacional_id` 2 não escolhe a empresa do PDV.

Na abertura, `alinharContextoPdvModeloEmpresa` lê `GET /api/vendas/pdv-modelo-empresa` e, se o modelo for `UNICA`, seleciona `pdv_empresa_id` no seletor. No fechamento, o middleware repete essa empresa.

A última venda persistida, id 35, está na empresa 1, origem `PDV`, forma dinheiro. Isso confirma o canal atual.

Há 18 vendas de origem `PDV` na empresa 2, a última com id 20. Nenhuma venda de PDV ficou na empresa 3. Não há origem iFood no banco.

## 3 e 4. Validação de pagamento e vínculo com a matriz

A mensagem de bloqueio é decidida no navegador, antes de `POST /api/vendas`, por `obterModoConfirmacaoFiscal` e `obterTefHabilitadoConfig`. Nenhuma das duas filtra empresa.

A tabela `tef_configuracao` tem uma linha, id 1, `habilitado` 0. `empresa_codigo`, `loja_codigo`, `pdv_codigo`, `terminal_codigo` e `caixa_codigo` estão nulos. Não há coluna de empresa do CDS nessa configuração. `processarPagamentosTef` lê esse registro global.

O orquestrador só compara `tef_transacoes.empresa_id` com a empresa da venda quando já existe transação TEF. Esse clique não cria transação. A única linha de TEF continua sendo a de 25/10/2026.

## 5. O bloqueio e a divergência

A divergência que existe é de configuração, não de pagamento:

| Fonte | Empresa |
| --- | --- |
| Matriz ativa (ordem `0001`) | 1 — Pastelaria do Cheff, Matriz |
| Canal PDV (`pdv_empresa_id`) | 1 |
| Última venda PDV | 1 |
| `empresa_operacional_id` | 2 — Filial 2, ordem `0003` |
| Outra empresa ativa | 3 — Filial 3, ordem `0002` |
| Configuração TEF | nenhuma empresa; flag global desligada |

Com `UNICA` e `pdv_empresa_id` 1, uma venda nova de balcão não é gravada na filial 2 nem na filial 3. O histórico até a venda 20 mostra que o balcão já foi persistido na filial 2. Não há mapa configurável de empresa por canal. iFood não tem tabela, origem nem roteador neste código.

Caixas abertos existem nas empresas 1, 2 e 3. O fechamento PDV valida o caixa da empresa 1. A venda 35 quitou nessa empresa. O texto de autorização de pagamento não é resposta de caixa nem de empresa.

## Correção mínima, ainda não aplicada

Não codificar ids nem CNPJs. O encaixe da regra aprovada seria um mapa configurável de canal para empresa, com o canal PDV apontando para a matriz já identificada pela ordem `0001`, e os outros canais apontando para as filiais só quando esses canais existirem. Hoje o PDV já está preso à empresa 1 por `pdv_empresa_id`. O bloqueio de cartão ou PIX continua sendo TEF desligado com modo `TEF`, independente dessa empresa.
