# PDV-MOBILE-04 — Segurança TEF e homologação da interface

## 1. Branch e commit

- Branch: `fix/p0-lentidao-cancelamento-nfce`
- Commit de referência: `0fab77d59ff5d283e23d4fdb0b624204a5293c34`
- As alterações locais da PDV-MOBILE-03 foram preservadas. Nenhuma branch foi trocada.

## 2. Rota e autorização encontradas

`GET /api/tef/acompanhamento` já usava:

- `verificarToken` — sessão JWT. Sem token, 401 `SESSAO_INVALIDA`.
- `resolverEmpresaAutorizadaTef` — a empresa sai do cabeçalho `X-Empresa-Id` já conferido por `exigirEmpresaAutorizada`, ou do único caixa aberto do operador.
- Consulta `SELECT` com `idempotency_key` e `empresa_id` autorizado. O parâmetro `empresa_id` da URL é ignorado.
- O fechamento oficial continua em `comprovarTransacoesTefAprovadas` e no `UPDATE` que só grava `venda_id` quando ele ainda é nulo e a empresa coincide.

O núcleo TEF não guarda o operador na transação. A leitura segue o mesmo recorte do `POST /api/tef/pagar`: usuário autenticado e empresa autorizada. Não foi criada uma permissão nova.

## 3. Lacunas

- A resposta devolvia NSU e autorização para quem conhecesse a chave.
- Uma transação já vinculada a uma venda continuava aparecendo como aprovada e aproveitável.
- O identificador da transação saía também nos estados pendente, recusado, cancelado, timeout e falha.

## 4. Correções

A resposta pública passou a sair só de `respostaAcompanhamentoPublica`: `encontrado`, `aprovado`, `status` e `executou_cobranca`. NSU, autorização, comprovante e payload não entram. `transacao_id`, `valor` e `tipo` só aparecem quando a cobrança está aprovada e ainda sem venda.

Se `venda_id` já existe, a leitura devolve `aprovado: false` e `TRANSACAO_JA_VINCULADA`. O celular usa o valor e o tipo persistidos e não copia NSU digitado no navegador. O vínculo definitivo continua no fechamento, que recusa a segunda venda.

A quantidade da venda avulsa passou a chamar de novo `cotarProduto`, o mesmo motor da PDV-MOBILE-03. A fórmula não foi alterada.

## 5. Isolamento multiempresa

No banco temporário `cds-mobpdv04-*`:

- Operador da empresa A com cabeçalho da empresa B: 403 `EMPRESA_NAO_AUTORIZADA`.
- Chave da empresa B, mesmo com `empresa_id` da B na URL e cabeçalho da A: `encontrado: false`, sem NSU.
- Operador sem vínculo: 403.
- Depois do vínculo, o `UPDATE` da mesma chave para outra venda alterou 0 linhas. O `UPDATE` usando a empresa B também alterou 0 linhas.

## 6. Leitura sem efeito colateral

Duas leituras da cobrança aprovada mantiveram uma única linha, o mesmo status e o mesmo `atualizado_em`. `venda_id` continuou nulo até o teste aplicar o vínculo. `autorizar`, `consultar`, `cancelar`, `reimprimir` e `status` do `TefManager` não foram chamados. Nenhum adaptador foi acionado.

## 7. Testes automatizados

`node --test --test-concurrency=1`

| Arquivo | Resultado |
| --- | --- |
| `tests/mobile-pdv/pdv-mobile-04.test.js` | 7 pass, 0 fail |
| `tests/mobile-pdv/pdv-mobile-03.test.js` | 13 pass, 0 fail |
| `tests/mobile-pdv/pdv-mobile-02.test.js` | 14 pass, 0 fail |
| `tests/pdv/sprint-25-interacao-sequencial.test.js` | 4 pass, 0 fail |
| `tests/vendas/sprint-2-6-atualizar-quantidade-atacado.test.js` | 9 pass, 0 fail |
| `tests/vendas/sprint-2-7-recalculo-preco-quantidade.test.js` | 16 pass, 0 fail |
| `tests/vendas/pedido-pdv-composicao.test.js` | 19 pass, 0 fail |

Cenários da rota: sessão ausente, operador sem empresa, outra empresa, troca de chave, cobrança aprovada, pendente, recusada, timeout, falha, cancelada, chave inexistente, leitura repetida e cobrança já vinculada.

## 8. Navegador

- Navegador do Cursor, viewport emulado de 390×844.
- A coluna medida ficou em 390 px.
- Servidor temporário em `http://127.0.0.1:3099`, banco `C:\Users\cicer\AppData\Local\Temp\cds-mobpdv04-ui\mercadao.db`.
- O banco oficial não foi aberto. O processo de teste foi encerrado ao final.

## 9. Cenários percorridos na tela

Percorridos:

- Login e troca obrigatória da senha inicial do administrador temporário.
- Abertura de `/mobile-pdv` com operador Administrador, venda avulsa e total R$ 0,00.
- Botões PIX, débito, crédito e dinheiro legíveis, sem sobreposição, com rolagem vertical.
- Dinheiro sem item exibiu “Inclua os itens antes do pagamento.” Nenhuma parcela entrou.
- Consulta da chave `corr-ui-aprovada` não criou parcela. A resposta HTTP foi 403 `LICENCA_AUSENTE` / “Sistema não ativado.”
- O botão “Solicitar emissão” permaneceu desabilitado.

Não percorridos, porque o servidor temporário não tem licença:

- Seletor de empresa do Mobile Pedido: a etapa mostrou `LICENCA_AUSENTE`. O nome “Pastelaria Teste” foi exibido depois de gravar no navegador o mesmo par `cds_empresa_id` / `cds_empresa` que o seletor grava quando a licença permite.
- Inclusão de produto, preço normal, promoção, atacado e alteração de quantidade.
- Pedido encaminhado, dinheiro confirmado, recomposição e fechamento.
- Estados aprovado, pendente, recusado e falha renderizados a partir de uma cobrança lida com sucesso.
- Não há modal de pagamento nesta tela. O valor fica no próprio fluxo.

## 10. Evidências visuais

As capturas da sessão mostram o login, a coluna do fechamento com a empresa ainda não selecionada e, depois, os botões de pagamento, o campo da cobrança `corr-ui-aprovada` e o texto de que o celular não comanda o pinpad. A mensagem de item ausente foi lida da página: “Inclua os itens antes do pagamento.”

## 11. Pendências

- A licença ausente no servidor temporário impede a homologação do carrinho, do preço e do acompanhamento bem-sucedido.
- Dois operadores da mesma empresa, se conhecerem a chave, ainda podem ler uma cobrança ainda não vinculada. O núcleo não registra o operador na transação. A reutilização em outra venda permanece bloqueada.
- Smart POS Itaú continua sem modelo e sem documentação.

## Classificação

| Item | Estado |
| --- | --- |
| Autenticação, empresa e isolamento da leitura | CONCLUÍDO, TESTADO |
| Resposta sem NSU, autorização ou cobrança já vinculada | CONCLUÍDO, TESTADO |
| Leitura sem adaptador e sem segunda transação | TESTADO |
| Login, coluna mobile, botões e bloqueio sem item | HOMOLOGADO |
| Preço, quantidade, dinheiro, recomposição e estados TEF na tela | BLOQUEADO pela licença do servidor temporário |
| Emissão fiscal no celular | BLOQUEADO |
| Smart POS Itaú | BLOQUEADO |
