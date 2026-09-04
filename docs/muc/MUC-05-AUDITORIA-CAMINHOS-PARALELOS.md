# MUC-05 — Auditoria dos caminhos paralelos de conversão

**Status:** CONCLUÍDA  
**Motor:** MUC RC2.1 (`obterMuc(db)`)  
**Regra desta sprint:** o MUC é a autoridade oficial para **conversão de quantidade entre unidades**. Outros módulos podem permanecer quando a responsabilidade **não** for esse cálculo.

Nenhum componente foi removido sem comprovação. Nenhuma migração insegura foi aplicada. O contrato público RC2.1 não foi alterado.

---

## 1. Objetivo

Descobrir onde ainda existem motores, fatores e fórmulas de conversão; classificar cada uso (A/B/C/D); migrar somente o que for conversão operacional de quantidade **e** puder ser substituído pelo MUC sem mudar ficha, consumo, cancelamento, devolução, estoque, venda, fiscal, Central ou PDV Universal.

---

## 2. Arquivos analisados

### Núcleo MUC (autoridade)

- `backend/motores/muc/index.js`, `public.js`
- `backend/motores/muc/core/MotorConversaoQuantidade.js`, `unidadesSi.js`
- `backend/motores/muc/core/MotorConversao.js`, `MotorConversaoCalculo.js`
- `backend/motores/muc/pipeline/PipelineMuc.js`
- `backend/motores/muc/schema/mucSchema.js`, `aprendizado/MotorAprendizado.js`, `auditoria/AuditoriaConversao.js`

### Caminhos paralelos auditados

- `backend/services/unidades/MotorUnidadesMedida.js`
- `backend/lib/motorConversaoUnidades.js`
- `frontend/erp/js/motor-unidades-medida.js`
- `frontend/shared/js/motor-quantidade-compra.js`
- `backend/services/importacao-inicial-produtos/helpers.js` (`calcularEstoqueInicial`)
- `backend/services/importacao-inicial-produtos/validator.js`, `quantidadeUpdater.js`
- `backend/services/fiscal/unidadeFiscal.js` (código fiscal, não conversão de quantidade)
- `backend/motores/equipamentos/layouts/ConfiguravelEtiquetaParser.js` (`payload / 1000` de protocolo)

### Consumidores oficiais do MUC

- `backend/rotas/compras.js` — `processarItemCompra` / persistência de estoque
- `backend/services/produtos/FichaTecnicaService.js` — `converterQuantidadeFicha`
- `backend/services/produtos/FichaTecnicaConsumoService.js` — `obterMuc(db).converterQuantidade`
- `backend/services/produtos/ProdutoConversaoConfigService.js` — validação/simulação via `converterQuantidade`
- `backend/rotas/compras.js` — `POST /simular-conversao-muc` (`muc.simular`)

### Outros pontos pesquisados (sem conversor paralelo operacional)

- `backend/rotas/produtos.js` — normalização de UC / custo de cadastro
- `backend/services/produto-embalagem/ProdutoEmbalagemService.js` — metadado `fator_conversao` = quantidade da apresentação
- `frontend/erp/js/compras.js`, `produtos.js`, `produto-embalagens.js`, `miip-central-revisao.js`
- `scripts/` — nenhum match de conversão
- `tests/muc/*`, `tests/pastelaria/*`, `tests/compras/*`, `tests/produtos/importacao-inicial-produtos.test.js`

Termos pesquisados: `MotorUnidadesMedida`, `motorConversaoUnidades`, `converterUnidade` (zero ocorrências), `converterQuantidade`, `fator_conversao` / `fatorConversao`, `unidade_origem` / `unidade_destino`, `unidade_compra` / `unidade_estoque` / `unidade_venda`, `embalagem`, `quantidadeEstoque`, `conversao`/`conversão`, `*1000`/`/1000`/`*100`/`/100`/`*1000000`/`/1000000`, comparações `unidade === 'KG'|'G'|'L'|'ML'`.

---

## 3. Consumidores encontrados

Ver matriz completa em [MUC-05-MATRIZ-CONSUMIDORES.md](./MUC-05-MATRIZ-CONSUMIDORES.md).

Resumo:

| Área | Quem converte quantidade? |
|------|---------------------------|
| Compra persistida | MUC (`processarItemCompra` → `quantidadeEstoque`) |
| Ficha / consumo / débito de insumo | MUC (`converterQuantidade`) |
| Cancelamento / devolução | Snapshot da venda (não reconverte) |
| Cadastro de conversão do produto | MUC (validação e simulação) |
| Formação de preço / UC / XML uCom | MotorUnidadesMedida (não é conversão SI operacional) |
| Custo, subtotal, rateio F/NF da compra | `motorConversaoUnidades.js` (usa quantidade já convertida) |
| Preview UI da compra | Espelho legado + `muc.simular` sem unidades SI |
| Importação inicial | `qtd × fator_conversao` próprio |
| Etiqueta de balança | Parser de protocolo (`g → kg` do payload) |

---

## 4. Classificação A / B / C / D

### A — Conversão de quantidade

Já no MUC (não migrar de novo):

- Pipeline de compra (`MotorConversaoCalculo.executar` → `converterQuantidade`)
- Ficha / consumo
- `ProdutoConversaoConfigService` (validação de relações)
- Wrapper `MotorUnidadesMedida.converterQuantidadeEntreUnidades` — **já delega** a `MotorConversaoQuantidade`

Ainda fora do MUC (não migrado nesta sprint):

- `calcularEstoqueInicial` — `quantidade_origem * fator_conversao` (importação)
- `obterQuantidadeConvertida` / `simularConversaoEmbalagem` — `embalagens × quantidade_por_embalagem` (pré-fill e preview)
- `MotorUnidadesMedida.calcularCompraEmbalagem` — mesmo multiplicador a serviço de **preço**
- Frontend `motor-quantidade-compra.js` — espelho do legado para UI
- `muc.simular` sem `unidadeOrigem`/`unidadeDestino` — cai no multiplicador legado

### B — Responsabilidade legítima (não é conversão de quantidade)

- Catálogo UC, `normalizarUnidadeComercial`, `identificarUnidadeDoXml`, `isUnidadeComercialConhecida`
- Formação de preço (`calcularFormacaoPrecoCadastro`, `resolverCustoUnitario*`, margem)
- Rateio fiscal / não fiscal e validação de soma F+NF = convertida
- Códigos fiscais (`unidadeFiscal.js` — uCom da NF-e)
- Metadados persistidos: `compras_itens.fator_conversao`, aprendizado MUC, apresentações
- Parser de etiqueta Toledo (`payloadNum / 1000` = protocolo de peso, não estoque)

### C — Sem consumidores reais (candidatos à remoção)

- `FATOR_UNIDADE_BASE` em `MotorUnidadesMedida.js` — morto após delegação SI ao MUC
- `listarUnidadesComerciais` — exportado, nenhum require externo
- `exigeQuantidadePorEmbalagem` — só uso interno + export; nenhum consumidor externo

**Não removidos.** Qualquer dúvida → candidato, não exclusão.

### D — Dependência temporária necessária

| Consumidor | Motivo | Fluxo | Substituição | Sprint sugerida |
|------------|--------|-------|--------------|-----------------|
| `motorConversaoUnidades` no pipeline | Custo, subtotal, split F/NF | Compra | Isolar F/NF/custo sem recalcular qtd | MUC-06 |
| `obterQuantidadeConvertida` em `processarItensCompra` | Pré-fill antes do MUC | Compra | Deixar só MUC preencher qtd | MUC-06 |
| `POST /simular-conversao-muc` | Preview sem unidades/relações | UI compra | Passar origem/destino/relações ao `simular` | MUC-06 |
| Frontend `motor-quantidade-compra.js` | Preview local | UI compra | Cliente oficial do MUC ou só backend | MUC-06 |
| Importação `calcularEstoqueInicial` | Não quebrar arquivos/import | Importação inicial | `obterMuc().converterQuantidade` quando houver unidades | MUC-07 |
| Wrapper `converterQuantidadeEntreUnidades` | Testes 03.04/03.06/03.07/03.08 e auditoria | Testes | Trocar oráculos para `converterQuantidade` | MUC-06 |
| `MotorConversao.calcularFormacaoPrecoCadastro` | Facade RC1 reexporta MotorUM | Compat API interna | Manter até aposentar facade legada | posterior |

---

## 5. Conversões paralelas encontradas

1. **Multiplicador comercial** (`qtdEmb × qtdPorEmb`) em legado, MotorUM (preço), frontend e `muc.simular` sem unidades.  
   Persistência oficial da compra **já sobrescreve** com `resultadoMuc.quantidadeEstoque`.

2. **Importação inicial** `qtd × fator` — caminho próprio, sem SI/encadeamento.

3. **Protocolo de etiqueta** `/1000` — não compete com o MUC.

4. **Fórmulas `*1000`/`/1000` no restante do projeto** — arredondamento (3 casas), moeda (`*100`), percentual, tempo (`ms/1000`). Não são conversão de unidades.

5. **Nenhum** `if (unidade === 'KG') quantidade *= 1000` operacional em services/rotas.

`converterUnidade` não existe no repositório.

---

## 6. Conversões migradas nesta sprint

Nenhuma.

Critério: só migrar se for conversão de quantidade, o MUC atender, o resultado for validável e o fluxo antigo puder sair sem mudança funcional indevida.

Os únicos trechos A ainda fora do MUC (importação, preview UI, pré-fill de compra) **ainda têm consumidores** e alterar compra/importação/UI foge das regras 5.4–5.8 ou quebra contratos já testados (rc43119, importação inicial). Classificados como **D**.

O wrapper SI do MotorUM **já estava migrado** (MUC-02/04).

---

## 7. Componentes mantidos

- `MotorUnidadesMedida` — preço, catálogo UC, flags de embalagem, normalização XML
- `motorConversaoUnidades.js` — custo, F/NF, subtotal, helpers de item de compra
- Schema/colunas `fator_conversao` — persistência e aprendizado MUC
- Frontend `motor-unidades-medida.js` e `motor-quantidade-compra.js`
- Importação inicial com fator próprio
- `unidadeFiscal.js` e parser de etiqueta

---

## 8. Componentes candidatos à remoção

| Item | Por quê | Ação MUC-05 |
|------|---------|-------------|
| `FATOR_UNIDADE_BASE` | Constante morta | Candidato — **não removido** |
| `listarUnidadesComerciais` | Sem consumidor | Candidato — **não removido** |
| Export externo de `exigeQuantidadePorEmbalagem` | Só uso interno | Candidato de enxugamento de API — **não removido** |

Nenhum arquivo (`MotorUnidadesMedida` / `motorConversaoUnidades.js`) é candidato à remoção do módulo inteiro.

---

## 9. Dependências temporárias

Ver tabela da seção 4.D.

Ponto crítico: `MotorConversaoCalculo` calcula quantidade pelo MUC e ainda chama o legado para F/NF. Se as quantidades divergem, o split F/NF é **escalado** na razão `qtdMuc / qtdLegado`. A quantidade de estoque gravada na compra é a do MUC.

---

## 10. Riscos identificados

| Risco | Severidade | Estoque pode divergir? |
|-------|------------|------------------------|
| Preview UI (`simular` sem SI / espelho frontend) ≠ persistência MUC | Média (UX) | Não no crédito oficial |
| Pré-fill `obterQuantidadeConvertida` alimenta custo/peso antes do MUC | Baixa | Persistência de qtd usa MUC |
| Importação inicial fora do MUC | Média (estoque inicial) | Sim, **só nesse fluxo**, se o fator do arquivo não refletir SI/encadeamento |
| Teste 03.05 T09 ainda aceita `MotorUM` no source do consumo (passa pelo comentário) | Baixa (oráculo velho) | Não |
| Wrapper MotorUM nos testes pastelaria | Baixa | Não — delega ao MUC |
| Dual path F/NF no pipeline | Baixa se MUC e legado alinhados | Qtd estoque = MUC |

**Não há segundo caminho operacional capaz de gerar divergência de estoque em venda, ficha, cancelamento ou devolução.**  
O único fluxo de estoque ainda fora do MUC é a **importação inicial de produtos**.

---

## 11. Testes executados

Ver `docs/IMPLEMENTACAO_MUC_05_RELATORIO.md`. Suíte MUC RC1/RC2 + MUC-02/03/04 + ficha/consumo/cancelamento/devolução + auditoria-muc-01. Nenhum teste foi alterado para passar. Nenhum teste novo (não houve migração).

---

## 12. Conclusão

O MUC já é a autoridade única de conversão de quantidade nos fluxos oficiais (compra persistida, ficha, consumo, cadastro de conversão). MotorUnidadesMedida e `motorConversaoUnidades.js` **não devem ser apagados**: o primeiro é catálogo/preço; o segundo é custo e F/NF.

A consolidação definitiva (MUC-06+) deve: (1) aposentar o pré-fill legado na compra; (2) fazer o preview usar o mesmo `converterQuantidade`; (3) planejar importação inicial; (4) remover constantes mortas após os testes deixarem de usar o wrapper.

Respostas do DoD (seção 15 da sprint):

1. Conversão fora do MUC: importação inicial, preview UI, multiplicador de preço, protocolo de etiqueta.  
2. MotorUnidadesMedida: cadastro produto, ficha (catálogo), importação (preço), facade MUC (preço), testes.  
3. `motorConversaoUnidades.js`: `rotas/compras.js`, `rotas/produtos.js` (custo cadastro), `MotorConversao` / `MotorConversaoCalculo`, testes de compra.  
4. `fator_conversao`: persistência MUC/compra, aprendizado, importação, UI de compras (eco do resultado).  
5. Legítimos: metadado, preço, F/NF, catálogo, protocolo.  
6. Devem migrar no futuro: importação (A/D), preview (D), pré-fill compra (D).  
7. Sem consumidores: `FATOR_UNIDADE_BASE`, `listarUnidadesComerciais`.  
8. Podem ser removidos hoje: nenhum com segurança absoluta exigida pela sprint.  
9. Permanecem temporariamente: legado de compra + wrapper de testes.  
10. Divergência de estoque operacional (venda/ficha): **não**. Importação inicial: **risco residual**.
