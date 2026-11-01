# Sprint 21I — Correção do contexto empresarial na reimpressão

A reimpressão do cupom não fiscal passa a consultar a venda com a empresa ativa já escolhida no PDV.

Data: 31/10/2026.

Parecer: **APROVADA**.

O backend não foi alterado. A exigência de `X-Empresa-Id` permanece.

## 1. Causa-raiz

`reimprimirCupomNaoFiscalHistorico`, em `frontend/shared/js/fiscalImpressao.js`, chamava `GET /api/vendas/:id` só com `Authorization`. Com mais de uma empresa no operador, o backend recusa a consulta sem `X-Empresa-Id`.

A lista e o modal já enviam esse header porque o `$.ajax` do PDV usa `CdsEmpresaContexto.anexarHeaderXhr`.

## 2. Mecanismo usado

A função usa o contexto oficial `CdsEmpresaContexto`, o mesmo da sessão:

- `temEmpresaSelecionada()` lê o id gravado por `persistir` em `localStorage` (`cds_empresa_id`).
- `headersAuth()` monta `Authorization` a partir do token da sessão e `X-Empresa-Id` a partir desse id.

Não há segundo seletor, empresa fixa nem id vindo de parâmetro. Sem empresa ativa válida, a função não consulta e avisa: `Selecione a empresa no seletor da barra lateral para continuar.`

O tratamento de erro, a montagem e a abertura do cupom continuam os mesmos.

## 3. Evidência dos headers

Banco temporário `C:\Users\cicer\AppData\Local\Temp\cds-sprint21i-rsGJlr\mercadao.db`. Log: `BANCO DE TESTE EM USO`. Operador vinculado às duas empresas.

| Cenário | Header enviado | Resultado |
|---|---|---|
| I1 / I2 — H-MISTA na empresa A | `X-Empresa-Id` da empresa A e `Authorization: Bearer` do token | Cupom aberto |
| I3 — venda da empresa B | `X-Empresa-Id` da empresa B e o mesmo token | Cupom com `NSU-EMPRESA-B` e total R$ 22,00 |
| I4 — venda da B com empresa ativa A | `X-Empresa-Id` da empresa A | Backend: `Venda não encontrada.` Cupom não aberto. O aviso não contém `NSU-EMPRESA-B` |
| I8 — empresa limpa | Nenhuma consulta | Aviso para selecionar a empresa. Zero chamadas |

## 4. H-MISTA

O comprovante da empresa A mostrou o recebimento não fiscal de R$ 4,00, `NSU: NSU-MISTA` e `Aut.: AUT-MISTA`.

A linha de total foi `Total: R$ 4,00`. O HTML não contém `Total: R$ 10,00`, `Total: R$ 14,00` nem `Total: R$ 20,00`.

## 5. Testes

`node --test --test-concurrency=1`, um arquivo por vez.

| Suíte | Resultado | Banco temporário |
|---|---|---|
| `tests/pdv/sprint-21-etapa-i-reimpressao-empresa.test.js` | 4/4 | `C:\Users\cicer\AppData\Local\Temp\cds-sprint21i-rsGJlr\mercadao.db` |
| Sprint 21G | 2/2 | `C:\Users\cicer\AppData\Local\Temp\cds-sprint21g-Qb5VNs\mercadao.db` |
| Sprint 21B e 21E | 14/14 | `C:\Users\cicer\AppData\Local\Temp\cds-sprint21b-pTP40s\mercadao.db` |
| Sprint 21C | 7/7 | `C:\Users\cicer\AppData\Local\Temp\cds-sprint21c-SdGfYg\mercadao.db` |
| Vínculo TEF (21F) | 14/14 | `C:\Users\cicer\AppData\Local\Temp\cds-sprint21v-mciBq1\mercadao.db` |

Contadores das regressões: 21B `autorizacoesReais` 0 e `emissoesFiscais` 0; 21C `autorizacoesReais` 0, `emissoesFiscais` 0 e `pagamentosMock` 1; vínculo `autorizacoesBloqueadas` 0 e `emissoesFiscais` 0.

## 6. Arquivos alterados

| Arquivo | Alteração |
|---|---|
| `frontend/shared/js/fiscalImpressao.js` | `reimprimirCupomNaoFiscalHistorico` envia `headersAuth()` ou interrompe sem consulta |
| `tests/pdv/sprint-21-etapa-i-reimpressao-empresa.test.js` | Cenários I1 a I8 |

Nenhuma migration. Banco oficial não aberto. Autorizações financeiras reais: 0. Emissões de NFC-e ou NF-e: 0. Transmissões à SEFAZ: 0.

## 7. Encerramento

Parecer: **APROVADA**.

Nenhuma outra sprint foi iniciada. Aguardando avaliação do Tech Lead.
