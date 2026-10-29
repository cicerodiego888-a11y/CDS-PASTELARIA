# PDV-MULTIEMPRESA-06 — Homologação integrada do seletor multiempresa

**Data:** 2026-10-26  
**Módulo:** PDV oficial `/pdv`  
**Pré-requisitos:** MUV-CAP-01, PDV-SEL-01, PDV-SEL-02, PDV-MULTIEMPRESA-04, PDV-MULTIEMPRESA-05  
**Tipo:** Validação integrada (sem alteração de regras)  
**Estado final:** **CONCLUÍDA** (evidências reproduzíveis em ambiente sintético isolado)

## 1. Objetivo

Comprovar que CAP-01 + SEL-01/02 + M04/M05 funcionam em conjunto e classificar bloqueios HTTP 409 do seletor com evidência de capacidade — sem alterar regras, sem forçar seleção e sem acesso a banco oficial/cliente.

## 2. Pré-verificação — versão em execução

| Artefato | Valor observado |
|---|---|
| `package.json` version | `1.0.3` |
| Branch | `fix/p0-lentidao-cancelamento-nfce` |
| HEAD | `ffce987` — *implemetação Diversas* (2026-10-26 17:08 -03) |
| Instalador | `dist/erp/CDS-ERP-Setup-1.0.3.exe` (mtime ~2026-10-26 17:19 -03 / 20:19Z) |
| Manifest build | commit `ffce987` |

### O que o instalador `1.0.3` / `ffce987` contém vs. worktree

| Componente | Em `ffce987` / Setup 1.0.3? | Worktree atual |
|---|---|---|
| `ServicoCapacidadeCarrinhoEmpresa.js` (CAP-01 base) | Sim (introdução) | **Modificado** (M04 por item + ficha SEL-03) |
| `selecionarEmpresaCapacidade.js` | Sim | Presente |
| `SelecaoEmpresaVendaPdvService.js` (SEL-01+) | **Não** (arquivo untracked) | Presente (obrigatório ao seletor HTTP) |
| `frontend/pdv/js/pdv.js` preview M05 | Parcial (pdv.js no commit; M05 no worktree) | **Modificado** (`montarItensSelecaoEmpresaPreviewPdv`) |
| Testes M04/M05/M06 / SEL-01/02 | Não no build | Presentes no worktree |

**Conclusão de versão:** a homologação integrada desta sprint valida o **código do worktree** (`npm start` / `node --test`), não o pacote instalado sozinho. O Setup `1.0.3` **não** incorpora integralmente SEL-01 (`SelecaoEmpresaVendaPdvService.js` ainda untracked) nem as alterações M04/M05 no motor/preview. **Não foi reconstruído o instalador** (restrito pelo escopo).

Para UI Electron com seletor completo: executar a partir do worktree (`npm start`), não apenas o Setup 1.0.3.

## 3. Escopo executado / não executado

| Feito | Não feito (restrito) |
|---|---|
| 8 cenários sintéticos `:memory:` | Alterar regras de capacidade |
| Evidência estruturada de 409 (C5/C6) | Eliminar 409 para forçar seleção |
| Regressões sequenciais CAP/SEL/M04/M05/M06 | Soma de estoque entre CNPJs / divisão de venda |
| Relatório com classificação | Auth / licença / motor fiscal / PDV Universal |
| | `CDS_ALLOW_OFFICIAL_DB` / SEFAZ / DB oficial |
| | Correções adicionais sem autorização TL |
| | Rebuild do instalador |

## 4. Ambiente e isolamento

- SQLite `:memory:` + CNPJs/produtos sintéticos.
- Sem `CDS_ALLOW_OFFICIAL_DB=1`, sem banco oficial/cliente, sem emissão SEFAZ.
- Preview montado via `montarItensSelecaoEmpresaPreviewPdv` (M05) + `avaliarSelecaoEmpresaPdv` (SEL-01) + motor CAP/M04.
- Suite: `tests/pdv/pdv-multiempresa-06-homologacao-integrada.test.js`.

## 5. Cenários de validação

| ID | Cenário | Resultado | Evidência |
|---|---|---|---|
| C1 | Carrinho homogêneo; matriz com capacidade | **PASS** | `selecionada.empresaId` = matriz; `bloqueio` null |
| C2 | Matriz incapaz → filial (`id ASC`) | **PASS** | Filial B antes de C; matriz estoque 0 |
| C3 | Misto com `tipo_saldo` F + NF por item | **PASS** | Preview propaga `tipo_saldo`; matriz atende |
| C4 | Sem campos por item; fallback operacional | **PASS** | `item_fiscal` sozinho não escolhe bucket; `emitir_fiscal=true` → 409; `false` → matriz NF |
| C5 | Nenhuma empresa atende (HTTP 409) | **PASS** | `code=NENHUMA_EMPRESA_ATENDE`; ver §6 |
| C6 | Ausência de soma entre CNPJs | **PASS** | 2+2+2=6 ≥ 5 agregado, mas bloqueio; venda não divide |
| C7 | Revalidação na “finalização” (2ª avaliação) | **PASS** | Preview não reserva; após baixa sintética → 409 |
| C8 | Caixa × empresa selecionada | **PASS** | Compatível OK; caixa outra empresa / ausente → `CAIXA_INCOMPATIVEL` status 409 |

**Execução:** `node --test tests/pdv/pdv-multiempresa-06-homologacao-integrada.test.js` → **8 pass / 0 fail**.

## 6. Investigação HTTP 409 (C5) — evidência

**Classificação:** **bloqueio legítimo** (capacidade insuficiente por empresa; política sem soma/divisão entre CNPJs).

Não há evidência, neste ambiente sintético, de divergência preview×finalização nem de defeito no seletor: o 409 espelha `capacidade.porEmpresa` com `atendeIntegralmente=false` em todas as empresas.

### Payload sanitizado (sem PII/credenciais)

```json
{
  "itens": [{ "produto_id": 1, "quantidade": 5, "unidade": "UN" }],
  "emitir_fiscal": true,
  "venda_fiscal": true,
  "origem": "PDV"
}
```

### Resposta equivalente ao contrato de preview (`success: false`, HTTP 409)

| Campo | Valor |
|---|---|
| `code` | `NENHUMA_EMPRESA_ATENDE` |
| `mensagem` | `Nenhuma empresa consegue atender integralmente ao pedido. A venda não será dividida entre CNPJs. Gargalos: produto 1, necessário 5, disponível 1, ESTOQUE_INSUFICIENTE_FISCAL` (×3 empresas) |

`selecao.capacidade.porEmpresa` (resumo):

| empresaId | atendeIntegralmente | Gargalo |
|---|---|---|
| 1 (matriz) | false | produto 1 — necessário 5 / disponível 1 |
| 2 (filial B) | false | idem |
| 3 (filial C) | false | idem |

**Código efetivamente executado:** worktree atual (serviços + `pdv.js` M05), não o ASAR do Setup 1.0.3 isolado.

### Outros 409 cobertos

| Código | Onde | Classificação |
|---|---|---|
| `NENHUMA_EMPRESA_ATENDE` | C4 (fiscal sem saldo F), C5, C6, C7 | Legítimo |
| `CAIXA_INCOMPATIVEL` | C8 (finalização / `validarCaixaDaEmpresaSelecionada`) | Legítimo — fora do preview |

## 7. Regressões direcionadas (sequenciais)

| Ordem | Suite | Resultado |
|---|---|---|
| 1 | `tests/muv/muv-cap-01-capacidade-selecao.test.js` | 10 pass / 0 fail |
| 2 | `tests/pdv/pdv-sel-01-selecao-empresa.test.js` | 18 pass / 0 fail |
| 3 | `tests/pdv/pdv-sel-02-e2e-selecao-empresa.test.js` | 7 pass / 0 fail |
| 4 | `tests/pdv/pdv-multiempresa-04-capacidade-por-item.test.js` | 10 pass / 0 fail |
| 5 | `tests/pdv/pdv-multiempresa-05-preview-itens.test.js` | 8 pass / 0 fail |
| 6 | `tests/pdv/pdv-multiempresa-06-homologacao-integrada.test.js` | 8 pass / 0 fail |

## 8. Causa concreta dos bloqueios do seletor (síntese)

1. **Capacidade por CNPJ sem agregação:** se nenhuma empresa cobre a venda inteira no bucket exigido, o preview responde 409 `NENHUMA_EMPRESA_ATENDE` com gargalos por empresa — comportamento esperado (C5/C6).
2. **Fallback operacional:** sem `tipo_saldo`/split no item, o tipo vem de `emitir_fiscal`/`venda_fiscal`; `item_fiscal` do catálogo **não** escolhe bucket (C4 / M05).
3. **Caixa:** incompatibilidade empresa×caixa gera 409 `CAIXA_INCOMPATIVEL` na validação de finalização, não no preview de capacidade (C8).
4. **Versão instalada:** se o operador usa só o Setup 1.0.3 sem o worktree atualizado, o seletor HTTP/serviço SEL pode estar incompleto — sintomas mistos (rotas/serviço ausente ou motor antigo) distintos do 409 legítimo de estoque. Homologação UI “instalador puro” **não** foi refeita aqui (requer rebuild autorizado).

## 9. Procedimento de homologação com dados sintéticos (quando DB real for inacessível)

1. Subir app a partir do **worktree** (`npm start`), nunca apontar `CDS_ALLOW_OFFICIAL_DB`.
2. Garantir ≥2 empresas ativas com CNPJs distintos e estoque_empresa por produto.
3. Repetir C1–C8 com quantidades controladas (matriz OK; matriz 0 + filial OK; misto F/NF; sem tipo por item; qty > qualquer empresa; agregado ≥ qty mas cada CNPJ < qty; preview → baixar estoque → preview de novo; caixa de outra empresa na finalização).
4. No DevTools Network, em `POST /api/vendas/selecao-empresa` com status 409, copiar `code`, `mensagem`, `selecao.capacidade.porEmpresa` (sanitizar PII).
5. Classificar só com evidência: legítimo / preview≠finalização / defeito.
6. Encerrar com o mesmo checklist da §5.

## 10. Pendências

1. **Rebuild/certificação do instalador** incluindo `SelecaoEmpresaVendaPdvService.js` + motor M04 + preview M05 — fora desta sprint; necessário para homologar o Setup 1.0.3 “puro”.
2. Homologação manual UI no Electron com Network 409 real — procedimento §9; não bloqueia CONCLUÍDA da validação sintética integrada.
3. Correções de produto (UI tipo_saldo, split antecipado no carrinho) — só com autorização do Tech Lead.

## 11. Encerramento

Critérios atendidos: oito cenários com evidência reproduzível; 409 C5 classificado como bloqueio legítimo; versão instalador vs worktree documentada; regressões CAP/SEL/M04/M05/M06 verdes; sem alteração de regras nem acesso a DB oficial.

**Estado: CONCLUÍDA**
