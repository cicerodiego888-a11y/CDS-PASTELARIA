# MUC-05 — Matriz de consumidores

Legenda de classificação: **A** conversão de quantidade · **B** responsabilidade legítima · **C** sem consumidores (candidato) · **D** dependência temporária.

| Componente | Função | Consumidor | Tipo | Classificação | Ação | Status |
|------------|--------|------------|------|---------------|------|--------|
| MUC | `converterQuantidade` | `FichaTecnicaConsumoService` | Consumo ficha → estoque | A | Manter autoridade | Oficial |
| MUC | `converterQuantidade` | `FichaTecnicaService.converterQuantidadeFicha` | Cadastro/helper ficha | A | Manter | Oficial |
| MUC | `converterQuantidade` | `ProdutoConversaoConfigService` | Validação relações | A | Manter | Oficial |
| MUC | `converterQuantidade` | `MotorConversaoCalculo` | Pipeline compra | A | Manter | Oficial |
| MUC | `converterQuantidade` | `MotorConversao.simularConversao` (com unidades) | Simulação SI | A | Manter | Oficial |
| MUC | `processarItemCompra` | `backend/rotas/compras.js` | Persistência compra | A | Manter | Oficial |
| MUC | `simular` | `POST /simular-conversao-muc` | Preview UI (sem unidades) | D | Evoluir para passar origem/destino | Temporário |
| MUC | `fatorConversao` (DTO/schema) | `compras_itens`, `MotorAprendizado`, auditoria | Persistência metadado | B | Manter | Oficial |
| MotorUM | `normalizarUnidadeComercial` | `rotas/produtos.js` POST/PUT | Cadastro UC | B | Manter | Oficial |
| MotorUM | `isUnidadeComercialConhecida` | `FichaTecnicaService.validarUnidadeFicha` | Catálogo (fallback UC) | B | Manter | Oficial |
| MotorUM | `normalizarUnidadeComercial` | `FichaTecnicaService.validarUnidadeFicha` | Catálogo UC | B | Manter | Oficial |
| MotorUM | `calcularFormacaoPrecoCadastro` | Importação inicial, `MotorConversao`, frontend `produto-embalagens.js` | Preço | B | Manter | Oficial |
| MotorUM | `calcularCompraEmbalagem` | Testes rc840/rc842; frontend cliente | Preço + qtd estoque UI | B / A residual | Manter (preço); não usar p/ estoque oficial | Oficial preço |
| MotorUM | `identificarUnidadeDoXml` | Testes; frontend MIIP (cliente) | Mapa uCom | B | Manter | Oficial |
| MotorUM | `produtoUsaCompraPorEmbalagem` | Testes rc842 | Flag cadastro | B | Manter | Oficial |
| MotorUM | `num` / `moeda` | Importação inicial helpers | Arredondamento preço | B | Manter | Oficial |
| MotorUM | `converterQuantidadeEntreUnidades` | Testes pastelaria + `auditoria-muc-01` | Wrapper → MUC | D | Depreciado; não remover | Wrapper |
| MotorUM | `FATOR_UNIDADE_BASE` | Nenhum | SI morto | C | Candidato remoção | Não removido |
| MotorUM | `listarUnidadesComerciais` | Nenhum externo | Catálogo | C | Candidato remoção | Não removido |
| MotorUM | `exigeQuantidadePorEmbalagem` | Só interno + export | Flag UC | C (API) / B (interno) | Manter interno | Não removido |
| MotorUM | `UNIDADES_COMERCIAIS` / `MAPA_UCOM_XML` | Uso interno do módulo | Catálogo | B | Manter | Oficial |
| motorConversaoUnidades | `obterQuantidadeConvertida` | `rotas/compras.js` pré-fill; MotorConversao reexport | Multiplicador comercial | D | Substituir por MUC no persist | Temporário |
| motorConversaoUnidades | `obterQuantidadeComercial` | `rotas/compras.js` | Identidade comercial | B | Manter | Oficial |
| motorConversaoUnidades | `resolverQuantidadesEstoqueCompraItem` | Pipeline MUC (F/NF); testes | Split F/NF | D / B | Manter F/NF; qtd oficial = MUC | Temporário qtd |
| motorConversaoUnidades | `resolverQuantidadesCompraItem` | `rotas/compras.js` | Split F/NF | B | Manter | Oficial |
| motorConversaoUnidades | `resolverCustoUnitarioCadastro` | Pipeline; `rotas/compras.js` | Custo | B | Manter | Oficial |
| motorConversaoUnidades | `resolverCustoUnitarioProdutoCadastro` | `rotas/produtos.js`; frontend produtos (cópia) | Custo cadastro | B | Manter | Oficial |
| motorConversaoUnidades | `resolverPrecosCadastroAposCompra` | `rotas/compras.js` | Preço pós-compra | B | Manter | Oficial |
| motorConversaoUnidades | `calcularSubtotalFinanceiroItemCompra` | Pipeline; fallback compras | Financeiro | B | Manter | Oficial |
| motorConversaoUnidades | `validarDistribuicaoConversaoUnidadesItem` | MotorConversao.validarDistribuicao | Consistência F/NF | B | Manter | Oficial |
| motorConversaoUnidades | `simularConversaoEmbalagem` | `MotorConversao.simularConversao` | Preview multiplicador | D | Só se `simular` sem unidades | Temporário |
| motorConversaoUnidades | `moeda` / `custoUnitarioVenda` | Compras, MotorConversao | Arredondamento | B | Manter | Oficial |
| motorConversaoUnidades | `itemCompraUsaConversaoUnidades` | `rotas/compras.js` | Flag fracionado | B | Manter | Oficial |
| Frontend | `motor-quantidade-compra.js` | `compras.js` | Preview local | D | Alinhar ao MUC | Temporário |
| Frontend | `motor-unidades-medida.js` | `produtos.js`, `produto-embalagens.js` | Preço UI | B | Manter | Oficial |
| Importação | `calcularEstoqueInicial` | validator, quantidadeUpdater | `qtd × fator` | D / A | Migrar quando houver unidades | Temporário |
| Importação | coluna `fator_conversao` arquivo | helpers.mapearLinhaQuantidade | Dado de arquivo | B / D | Compatibilidade import | Temporário |
| Embalagem | `fator_conversao: emb.quantidade` | `ProdutoEmbalagemService` | Metadado apresentação | B | Manter | Oficial |
| Fiscal | `normalizarUnidadeComercialFiscal` | xmlBuilder, testes | uCom NF-e | B | Não migrar (regra 5.5) | Oficial |
| Equipamento | `payloadNum / 1000` | `ConfiguravelEtiquetaParser` | Protocolo peso | B | Não migrar | Oficial |
| Estoque fiscal | `resolverQuantidadesCompraItemPersistido` | `rotas/compras.js` devolução | Lê qtd já persistida | B | Não é conversor | Oficial |
