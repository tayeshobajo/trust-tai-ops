
-- project_recommendations
DROP POLICY IF EXISTS project_recommendations_same_org ON public.project_recommendations;
CREATE POLICY project_recommendations_read_same_org ON public.project_recommendations FOR SELECT USING (EXISTS (SELECT 1 FROM public.projects p WHERE p.id = project_recommendations.project_id AND p.organization_id = private.current_organization_id()));
CREATE POLICY project_recommendations_insert_ops ON public.project_recommendations FOR INSERT WITH CHECK (EXISTS (SELECT 1 FROM public.projects p WHERE p.id = project_recommendations.project_id AND p.organization_id = private.current_organization_id() AND public.can_write_ops()));
CREATE POLICY project_recommendations_update_ops ON public.project_recommendations FOR UPDATE USING (EXISTS (SELECT 1 FROM public.projects p WHERE p.id = project_recommendations.project_id AND p.organization_id = private.current_organization_id() AND public.can_write_ops())) WITH CHECK (EXISTS (SELECT 1 FROM public.projects p WHERE p.id = project_recommendations.project_id AND p.organization_id = private.current_organization_id() AND public.can_write_ops()));
CREATE POLICY project_recommendations_delete_ops ON public.project_recommendations FOR DELETE USING (EXISTS (SELECT 1 FROM public.projects p WHERE p.id = project_recommendations.project_id AND p.organization_id = private.current_organization_id() AND public.can_write_ops()));

-- project_risk_flags
DROP POLICY IF EXISTS project_risk_flags_same_org ON public.project_risk_flags;
CREATE POLICY project_risk_flags_read_same_org ON public.project_risk_flags FOR SELECT USING (EXISTS (SELECT 1 FROM public.projects p WHERE p.id = project_risk_flags.project_id AND p.organization_id = private.current_organization_id()));
CREATE POLICY project_risk_flags_insert_ops ON public.project_risk_flags FOR INSERT WITH CHECK (EXISTS (SELECT 1 FROM public.projects p WHERE p.id = project_risk_flags.project_id AND p.organization_id = private.current_organization_id() AND public.can_write_ops()));
CREATE POLICY project_risk_flags_update_ops ON public.project_risk_flags FOR UPDATE USING (EXISTS (SELECT 1 FROM public.projects p WHERE p.id = project_risk_flags.project_id AND p.organization_id = private.current_organization_id() AND public.can_write_ops())) WITH CHECK (EXISTS (SELECT 1 FROM public.projects p WHERE p.id = project_risk_flags.project_id AND p.organization_id = private.current_organization_id() AND public.can_write_ops()));
CREATE POLICY project_risk_flags_delete_ops ON public.project_risk_flags FOR DELETE USING (EXISTS (SELECT 1 FROM public.projects p WHERE p.id = project_risk_flags.project_id AND p.organization_id = private.current_organization_id() AND public.can_write_ops()));

-- qa_rules
DROP POLICY IF EXISTS qa_rules_same_org ON public.qa_rules;
CREATE POLICY qa_rules_read_same_org ON public.qa_rules FOR SELECT USING (EXISTS (SELECT 1 FROM public.projects p WHERE p.id = qa_rules.project_id AND p.organization_id = private.current_organization_id()));
CREATE POLICY qa_rules_insert_ops ON public.qa_rules FOR INSERT WITH CHECK (EXISTS (SELECT 1 FROM public.projects p WHERE p.id = qa_rules.project_id AND p.organization_id = private.current_organization_id() AND public.can_write_ops()));
CREATE POLICY qa_rules_update_ops ON public.qa_rules FOR UPDATE USING (EXISTS (SELECT 1 FROM public.projects p WHERE p.id = qa_rules.project_id AND p.organization_id = private.current_organization_id() AND public.can_write_ops())) WITH CHECK (EXISTS (SELECT 1 FROM public.projects p WHERE p.id = qa_rules.project_id AND p.organization_id = private.current_organization_id() AND public.can_write_ops()));
CREATE POLICY qa_rules_delete_ops ON public.qa_rules FOR DELETE USING (EXISTS (SELECT 1 FROM public.projects p WHERE p.id = qa_rules.project_id AND p.organization_id = private.current_organization_id() AND public.can_write_ops()));

-- qa_results
DROP POLICY IF EXISTS qa_results_same_org ON public.qa_results;
CREATE POLICY qa_results_read_same_org ON public.qa_results FOR SELECT USING (EXISTS (SELECT 1 FROM public.qa_reports qr JOIN public.runs r ON r.id = qr.run_id JOIN public.projects p ON p.id = r.project_id WHERE qr.id = qa_results.qa_report_id AND p.organization_id = private.current_organization_id()));
CREATE POLICY qa_results_insert_ops ON public.qa_results FOR INSERT WITH CHECK (EXISTS (SELECT 1 FROM public.qa_reports qr JOIN public.runs r ON r.id = qr.run_id JOIN public.projects p ON p.id = r.project_id WHERE qr.id = qa_results.qa_report_id AND p.organization_id = private.current_organization_id() AND public.can_write_ops()));
CREATE POLICY qa_results_update_ops ON public.qa_results FOR UPDATE USING (EXISTS (SELECT 1 FROM public.qa_reports qr JOIN public.runs r ON r.id = qr.run_id JOIN public.projects p ON p.id = r.project_id WHERE qr.id = qa_results.qa_report_id AND p.organization_id = private.current_organization_id() AND public.can_write_ops())) WITH CHECK (EXISTS (SELECT 1 FROM public.qa_reports qr JOIN public.runs r ON r.id = qr.run_id JOIN public.projects p ON p.id = r.project_id WHERE qr.id = qa_results.qa_report_id AND p.organization_id = private.current_organization_id() AND public.can_write_ops()));
CREATE POLICY qa_results_delete_ops ON public.qa_results FOR DELETE USING (EXISTS (SELECT 1 FROM public.qa_reports qr JOIN public.runs r ON r.id = qr.run_id JOIN public.projects p ON p.id = r.project_id WHERE qr.id = qa_results.qa_report_id AND p.organization_id = private.current_organization_id() AND public.can_write_ops()));

-- runs
DROP POLICY IF EXISTS runs_same_org ON public.runs;
CREATE POLICY runs_read_same_org ON public.runs FOR SELECT USING (EXISTS (SELECT 1 FROM public.projects p WHERE p.id = runs.project_id AND p.organization_id = private.current_organization_id()));
CREATE POLICY runs_insert_ops ON public.runs FOR INSERT WITH CHECK (EXISTS (SELECT 1 FROM public.projects p WHERE p.id = runs.project_id AND p.organization_id = private.current_organization_id() AND public.can_write_ops()));
CREATE POLICY runs_update_ops ON public.runs FOR UPDATE USING (EXISTS (SELECT 1 FROM public.projects p WHERE p.id = runs.project_id AND p.organization_id = private.current_organization_id() AND public.can_write_ops())) WITH CHECK (EXISTS (SELECT 1 FROM public.projects p WHERE p.id = runs.project_id AND p.organization_id = private.current_organization_id() AND public.can_write_ops()));
CREATE POLICY runs_delete_ops ON public.runs FOR DELETE USING (EXISTS (SELECT 1 FROM public.projects p WHERE p.id = runs.project_id AND p.organization_id = private.current_organization_id() AND public.can_write_ops()));
