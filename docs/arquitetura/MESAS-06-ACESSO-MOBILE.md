# MESAS-06 — Diagnóstico e liberação do acesso mobile

**Tipo:** auditoria técnica e correção focada na interface mobile.
**Escopo:** frontend mobile. Nenhuma regra comercial, fiscal, de consolidação ou do Motor F×NF foi alterada; nenhuma API nova; nenhum acesso ao banco oficial; nenhuma venda, pagamento ou evento SEFAZ; instalador não reconstruído.

## 1. Diagnóstico e causa raiz

| # | Verificação | Resultado |
|---|-------------|-----------|
| 1 | MESAS na navegação mobile | **Ausente.** `frontend/mobile/index.html` só oferecia PEDIDO e PDV. |
| 2 | Bloqueio por resolução/breakpoint/dispositivo | Não existe. O ERP (`/erp`) é um layout desktop (sidebar + Bootstrap); não há detecção de dispositivo. |
| 3 | Menu mobile × permissões/licenças | O menu mobile não aplica permissões por usuário (PEDIDO e PDV também não). A licença é aplicada no backend por `exigirRecurso('pedidos')` em `/api/mesas`. |
| 4 | Rota `mesas` no app mobile | **Inexistente.** Não havia `/mobile-mesas`. A rota `mesas` só existe no ERP desktop (`data-page="mesas"`). |
| 5 | Responsividade de `mesas-painel.js`, `mesas-lancamento.js` e estilos | Painel/modais são Bootstrap desktop. O lançamento desktop passa pela página `pedidos.js`, inutilizável no celular. O **controlador** do painel é agnóstico de HTML e foi reaproveitado. |
| 6 | Modal/camada bloqueando toque | Não encontrado no mobile (a tela nunca era carregada). Na nova tela foi verificado `elementFromPoint` sobre os botões. |
| 7 | APIs pelo celular (auth, sessão, empresa) | Contrato íntegro: `Authorization` + `X-Empresa-Id`; o backend resolve empresa/operador/atendimento. |
| 8 | Erros JS/HTTP | Sem erros de JS nas telas novas. Único 404 no harness foi o logotipo (asset do harness, não do sistema). |

**Causas raiz**

1. **Sem porta de entrada:** o home mobile não tinha link para MESAS e o servidor não tinha a rota `/mobile-mesas`.
2. **Lançamento sem mesa:** `mobile-pedido` fixava `mesa_id: null`, então mesmo chegando às mesas não era possível lançar pedido vinculado.
3. **Redirecionamento pós-login:** `destinoNavegacaoSeguro` (`pdv-acesso-oficial.js`) não permitia `/mobile-mesas` em `?next=`, derrubando o retorno após reautenticar.
4. **Sessão vencida deixava a tela em branco (achado em uso real):** com token inválido/expirado o backend responde **403** `{ error: 'Token inválido ou expirado', code: 'SESSAO_INVALIDA' }` (`backend/middleware/auth.js`). A primeira versão de `mobile-mesas.js` só tratava HTTP 401 e os erros do `CdsEmpresaContexto` (que expõem `status`/`code`, não `autenticacao`) nem eram avaliados; o operador via a mensagem “Token inválido ou expirado” e nenhuma mesa. Corrigido com `sessaoInvalida()` (401 **ou** `SESSAO_INVALIDA`): limpa o token vencido e redireciona para `/login?next=/mobile-mesas`. Falhas não ligadas à sessão agora mostram o aviso com botão “Tentar novamente”.

## 2. Correção aplicada

Um casco mobile fino que **reutiliza** controlador e conferência do desktop e as APIs existentes. Não há segundo módulo nem regra de negócio duplicada.

- **`/mobile-mesas`** (novo): lista de cartões verticais (número grande, selo de estado Livre/Ocupada/Fechamento, filtros, permanência); detalhe por mesa; conferência do pedido com “Enviar para preparação”; transferência; consulta somente leitura em fechamento.
  - Livre: busca opcional de cliente e “Abrir atendimento” (`POST /mesas/:id/atendimento`) e segue para o lançamento.
  - Ocupada: pedidos e estados de preparação, “Lançar pedido”, “Conferir/Ver pedido”, “Transferir atendimento”.
  - Fechamento: somente leitura, sem lançar pedido.
- **`mobile-pedido` em modo mesa** (`?mesa=ID`): valida `GET /mesas/:id/atendimento` (exige OCUPADA com atendimento), exibe faixa “Pedido da mesa N”, envia somente `mesa_id` em `POST /pedidos`, bloqueia gravação em mesa livre/fechamento, esconde “Enviar para o PDV” e guarda rascunho separado (`cdsMobilePedido:mesa:ID`).
- **Segurança preservada:** o cliente nunca envia `empresa_id`, `operador_id` nem `mesa_atendimento_id`; o backend resolve o atendimento ativo, aplica 409 `MESA_OCUPADA` em reabertura e idempotência (`Idempotency-Key` por operação).
- **Rede:** falha de conexão não confirma a operação (mensagem orienta conferir a mesa); banner offline; recuperação automática por polling, `online` e `visibilitychange`; a URL (`?mesa=&pedido=`) é regravada com `history.replaceState`, então atualizar a tela nunca recria atendimento ou pedido. HTTP 401 redireciona para `/login?next=/mobile-mesas`.

### Arquivos alterados

Novos: `frontend/mobile-mesas/index.html`, `mobile-mesas.css`, `mobile-mesas.js`; `tests/mobile-mesas/mobile-mesas-06.test.js`.

Alterados:
- `frontend/mobile/index.html` (link MESAS)
- `backend/server.js` (rota `/mobile-mesas`)
- `frontend/shared/js/pdv-acesso-oficial.js` (`/mobile-mesas` em `next=`)
- `frontend/mobile-pedido/index.html`, `mobile-pedido.css`, `mobile-pedido.js` (modo mesa)
- `frontend/shared/js/cds-mobile-operacao.js` (rascunho por mesa)
- `tests/erp/mesas-05-2-envio-preparacao.test.js` e `tests/erp/mesas-05-2-1-ciclo-mesa.test.js`: a asserção `mesa_id: null` do mobile-pedido passou a `mesa_id: estado.mesaId ? Number(estado.mesaId) : null` e ganhou a garantia de que `mesa_atendimento_id:` nunca é enviado. É a mudança intencional desta sprint.

Reutilizados sem alteração: `mesas-painel.js`, `mesas-conferencia.js`, `mesas-lancamento.js`, `backend/rotas/mesas.js`, `backend/rotas/pedidos.js`.

## 3. Testes executados

| Suíte | Resultado |
|-------|-----------|
| `tests/mobile-mesas/mobile-mesas-06.test.js` (novo) | **11/11** |
| `tests/erp/mesas-05-painel`, `05-1`, `05-2`, `05-2-1`, `05-2-2`, `05-3` | **todas passam** (11, 10, 6, 10, 4, 17) |
| `tests/mobile-pedido/mobile-pedido-02.test.js` | 10/10 |
| `tests/mobile-pdv/*` | sem falhas |
| `tests/pedidos/mesas-02`, `03`, `04` | **falham (7, 10 e 4 testes) por `SQLITE_ERROR: no such table: clientes`** em `MesaAtendimentoService.js` com o banco isolado dos testes |

**Sobre mesas-02/03/04:** a falha vem do serviço de backend (`LEFT JOIN clientes`) rodando em banco de teste sem a tabela `clientes`. Esta sprint não alterou nenhum arquivo de backend além da rota estática em `server.js`, que esses testes não carregam; `MesaAtendimentoService.js` e os próprios testes são arquivos ainda não versionados de sprints anteriores. Tratado como problema pré-existente e **não corrigido aqui**, mas deve ser resolvido antes de homologar a cadeia MESAS-02…04.

Mapeamento dos 12 testes obrigatórios: 1 (menu), 2 (carga), 3 (abertura de livre), 4 (mesa ocupada), 5 (dois pedidos), 6 (consulta), 7 (conferência), 8 (envio), 9 (transferência), 10 (bloqueio de atendimento inexistente/fechamento), 11 (offline/recuperação), 12 (refresh) — todos exercitados na validação visual abaixo; 2, 10 (parte), 11 e 12 também em teste automatizado.

## 4. Validação visual em navegador mobile

Navegador integrado com viewport de celular (largura ~390 px, depois ~294 px de área útil), servindo o `frontend/` real com uma **API simulada em memória** (sem banco, sem backend oficial). Fluxo executado:

1. Home mobile mostra PEDIDO, **MESAS**, PDV; o toque em MESAS abre `/mobile-mesas/`.
2. 8 mesas em cartões verticais, número grande, selo “Livre”, contadores; mesa 08 “desativada”.
3. Mesa 01 → “Abrir atendimento” → `/mobile-pedido/?mesa=1` com faixa “Pedido da mesa 1”.
4. Pedido gravado com toque duplo em “Gravar pedido”: **1 pedido, 1 atendimento** (idempotência).
5. “Novo pedido” → segundo pedido na mesma mesa: **2 pedidos, 1 atendimento**.
6. “Conferir e enviar para preparação” → conferência na página → envio com toque duplo: **1 envio**; atualizar a tela manteve contagens (1 atendimento, 2 pedidos, 1 envio).
7. Detalhe da mesa ocupada: pedidos com estado comercial/preparação/tempo; botões de 52 px.
8. Transferência 01 → 04: pedidos acompanham, URL passa a `?mesa=4`.
9. Conexão derrubada: banner “Sem conexão… será repetida sozinha”, últimos dados mantidos; ao voltar a rede a tela se recompôs sozinha.
10. `/mobile-pedido/?mesa=2` (mesa livre): mensagem “Esta mesa não tem atendimento aberto…” e botão Gravar oculto.
11. Sem token: redireciona para `/login?next=/mobile-mesas`.
12. Sem rolagem horizontal (`scrollWidth == clientWidth`) em lista, detalhe e pedido.
13. Token vencido (mock respondendo 403 `SESSAO_INVALIDA`, corpo idêntico ao backend real): a tela limpa o token e vai para `/login?next=/mobile-mesas`.

Capturas salvas fora do repositório (sessão): `lista.png`, `detalhe-ocupada.png`, `offline.png`, `pedido-mesa-livre.png`.

## 5. Limitações

- **Validação em aparelho físico não realizada.** A validação foi em navegador de desktop com viewport mobile e **API simulada**, não contra o backend real (licença/autenticação do ambiente). Antes da homologação, repetir o fluxo em um celular real contra o ERP de homologação.
- Corrigir/editar lançamento (“Corrigir lançamento”) não é oferecido no mobile.
- Venda individual e venda consolidada **não** são acionadas no mobile; em FECHAMENTO a tela é somente consulta. A venda continua no desktop/PDV (regras de MESAS-05.3 inalteradas).
- O menu mobile não aplica permissão por usuário (como PEDIDO/PDV); a licença é imposta pelo backend.
- Estados “encerrada” e “em fechamento” no backend real dependem de MESAS-02…05.3; aqui foram cobertos por teste unitário e pelo bloqueio de mesa livre.
- A suíte `tests/pedidos/mesas-02/03/04` falha por `clientes` ausente no banco de teste (ver seção 3).
- No navegador integrado, cliques com coordenadas falharam por escala de viewport; os toques foram executados via DOM. Verificado com `elementFromPoint` que nenhuma camada cobre os botões.
