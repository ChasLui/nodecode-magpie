;;;; A JSON-lines eval service for the free NodeCode lane.
;;;;
;;;; `nodecode trial` reads one form from stdin and evaluates it in a complete
;;;; NodeCode image.  This file turns that one shot into a long-lived service:
;;;; it binds a Unix socket, reads one JSON object per line, and evaluates the
;;;; requested form on its own thread so a slow form never blocks the next
;;;; request.  The protocol mirrors what the NodeCode CLI itself offers the
;;;; model: a yield window, then a running envelope with an id that can be
;;;; polled, awaited or interrupted.
;;;;
;;;;   -> {"op":"eval","form":"(sh \"ls\")","yield_time_ms":1000}
;;;;   <- {"status":"exited","output":"","value":"...","error":false}
;;;;   <- {"status":"running","eval_id":3,"output":"..."}
;;;;   -> {"op":"status","id":3}
;;;;   -> {"op":"interrupt","id":3,"force":false}
;;;;   -> {"op":"list"}
;;;;   -> {"op":"ping"}
;;;;
;;;; `(look ...)` inside the image is served by the plugin's vision model over a
;;;; second Unix socket, so a form can use the CLI's native look verb instead of
;;;; the (magpie-tool "look" ...) carrier.
;;;;
;;;; A form that is still running when its yield window expires is a background
;;;; eval.  The NodeCode CLI keeps the exit result in the session log; this
;;;; service appends it to a per-session log file so a later image can still
;;;; read it with (magpie-eval-log).

(progn
  (require :sb-bsd-sockets)

  (defvar *magpie-evals* (make-hash-table :test 'eql))
  (defvar *magpie-seq* 0)
  ;; The eval tool ships named literals beside the form; NodeCode binds them in
  ;; *eval-strings* and ($ "name") reads them.  Our service evaluates on its own
  ;; threads, so it must bind that special itself.
  (defvar *magpie-strings-symbol* (find-symbol "*EVAL-STRINGS*" :nodecode.evolved))
  (defvar *magpie-look-socket* __MAGPIE_LOOK_SOCKET__)
  ;; A restart drops the image, so finished background evals are appended here
  ;; for the next image to read.
  (defvar *magpie-eval-log-path* __MAGPIE_EVAL_LOG__)
  (defconstant +magpie-eval-log-max-bytes+ 131072)
  (defconstant +magpie-eval-log-keep-bytes+ 65536)

  (defstruct (magpie-eval (:constructor %make-magpie-eval))
    id thread stream log-stream value error-p done-p background-p logged-p started-at)

  (defun magpie-json (pairs)
    "Build a JSON object from an alist of (key . value) pairs."
    (let ((table (make-hash-table :test 'equal)))
      (dolist (pair pairs)
        (setf (gethash (car pair) table) (cdr pair)))
      table))

  (defun magpie-drain (ev)
    "Take everything the evaluation has printed since the last look."
    (let ((stream (magpie-eval-stream ev)))
      (if stream (get-output-stream-string stream) "")))

  (defun magpie-look (path &key prompt)
    "Ask the plugin's vision model to describe PATH, from inside the image."
    (if (or (null *magpie-look-socket*) (string= *magpie-look-socket* ""))
        (error "look is not configured")
        (let ((sock (make-instance 'sb-bsd-sockets:local-socket
                                   :type :stream :protocol 0)))
          (unwind-protect
               (progn
                 (sb-bsd-sockets:socket-connect sock *magpie-look-socket*)
                 (with-open-stream
                     (stream (sb-bsd-sockets:socket-make-stream
                              sock :input t :output t :element-type 'character
                              :buffering :full))
                   (let ((request (magpie-json
                                   (list (cons "path" (princ-to-string path))
                                         (cons "prompt" (or prompt ""))))))
                     (format stream "~a~%" (nlk:encode-json-object request))
                     (finish-output stream)
                     (let* ((line (read-line stream nil :eof))
                            (response (and line (not (eq line :eof))
                                           (nlk:decode-json line :whole t))))
                       (cond ((null response)
                              (error "look: no response from plugin"))
                             ((gethash "ok" response)
                              (gethash "text" response))
                             (t (error "look: ~a" (gethash "error" response))))))))
            (ignore-errors (sb-bsd-sockets:socket-close sock))))))

  (defun magpie-start (form-text &optional strings)
    (let* ((id (incf *magpie-seq*))
           (stream (make-string-output-stream))
           (log-stream (make-string-output-stream))
           (ev (%make-magpie-eval :id id :stream stream :log-stream log-stream
                                  :started-at (get-universal-time)))
           (bind-strings (and *magpie-strings-symbol*
                              (hash-table-p strings)
                              (boundp *magpie-strings-symbol*))))
      (setf (gethash id *magpie-evals*) ev)
      (setf (magpie-eval-thread ev)
            (sb-thread:make-thread
             (lambda ()
               (progv (if bind-strings (list *magpie-strings-symbol*) '())
                      (if bind-strings (list strings) '())
                 (let ((out (make-broadcast-stream stream log-stream)))
                   (let ((*standard-output* out)
                         (*error-output* out)
                         (*trace-output* out))
                     (handler-case
                         (multiple-value-bind (text err) (eval-string form-text)
                           (setf (magpie-eval-value ev) (magpie-display-text text)
                                 (magpie-eval-error-p ev) (and err t)))
                       (error (e)
                         (setf (magpie-eval-value ev) (format nil "ERROR: ~a" e)
                               (magpie-eval-error-p ev) t)))))
                 (setf (magpie-eval-done-p ev) t)
                 (magpie-log-eval ev)))
             :name (format nil "magpie-eval-~d" id)))
      ev))

  (defun magpie-park (ev yield-ms)
    "Wait up to YIELD-MS for EV, then answer whether it finished."
    (when (and (plusp yield-ms) (not (magpie-eval-done-p ev)))
      (handler-case
          (sb-thread:join-thread (magpie-eval-thread ev)
                                 :timeout (/ yield-ms 1000.0)
                                 :default :timeout)
        (error () nil)))
    (magpie-eval-done-p ev))

  (defun magpie-display-text (text)
    "Show a lone printed string literal as the text it is, as the CLI does."
    (let ((trimmed (string-trim '(#\Space #\Tab #\Newline #\Return) (or text ""))))
      (if (and (> (length trimmed) 1) (char= #\" (char trimmed 0)))
          (let ((*read-eval* nil))
            (handler-case
                (multiple-value-bind (value end) (read-from-string trimmed)
                  (if (and (stringp value) (plusp (length value)) (= end (length trimmed)))
                      value
                      text))
              (error () text)))
          text)))

  (defun magpie-trim-eval-log ()
    "Keep the log bounded: past MAX bytes, keep the tail from a record edge."
    (let ((path *magpie-eval-log-path*))
      (when (and (stringp path) (plusp (length path)) (probe-file path))
        (handler-case
            (let ((size (with-open-file (f path :element-type '(unsigned-byte 8))
                          (file-length f))))
              (when (> size +magpie-eval-log-max-bytes+)
                (let* ((text (uiop:read-file-string path))
                       (cut (max 0 (- (length text) +magpie-eval-log-keep-bytes+)))
                       (start (or (search "--- eval " text :start2 cut) cut)))
                  (with-open-file (f path :direction :output :if-exists :supersede
                                          :if-does-not-exist :create)
                    (write-string (subseq text start) f)))))
          (error () nil)))))

  (defun magpie-log-eval (ev)
    "Append one finished background eval to the log a later image can read."
    (when (and (stringp *magpie-eval-log-path*)
               (plusp (length *magpie-eval-log-path*))
               (magpie-eval-background-p ev)
               (magpie-eval-done-p ev)
               (not (magpie-eval-logged-p ev)))
      (setf (magpie-eval-logged-p ev) t)
      (let ((output (ignore-errors (get-output-stream-string (magpie-eval-log-stream ev)))))
        (handler-case
            (progn
              (ensure-directories-exist *magpie-eval-log-path*)
              (with-open-file (f *magpie-eval-log-path*
                                 :direction :output :if-exists :append
                                 :if-does-not-exist :create)
                (format f "--- eval ~a (background) ---~%value: ~a~%"
                        (magpie-eval-id ev) (or (magpie-eval-value ev) ""))
                (when (and output (plusp (length output)))
                  (format f "output:~%~a~%" output)))
              (magpie-trim-eval-log))
          (error () nil))))
    t)

  (defun magpie-log-records (text)
    (let ((starts '())
          (from 0))
      (loop for pos = (search "--- eval " text :start2 from)
            while pos do (push pos starts) (setf from (1+ pos)))
      (loop for tail on (nreverse starts)
            for start = (car tail)
            for end = (or (cadr tail) (length text))
            collect (string-trim '(#\Newline #\Space) (subseq text start end)))))

  (defun magpie-eval-log (&optional (limit 20))
    "Background eval exits from this and earlier images, oldest first."
    (if (or (not (stringp *magpie-eval-log-path*))
            (zerop (length *magpie-eval-log-path*))
            (not (probe-file *magpie-eval-log-path*)))
        "no background eval log yet"
        (let ((records (ignore-errors
                        (magpie-log-records (uiop:read-file-string *magpie-eval-log-path*)))))
          (if (null records)
              "no background eval log yet"
              (let ((limit (max 1 (min 100 (or limit 20)))))
                (format nil "~{~a~^~%~}"
                        (last records (min limit (length records)))))))))

  (defun magpie-exited (ev)
    (magpie-json
     (list (cons "status" "exited")
           (cons "eval_id" (magpie-eval-id ev))
           (cons "output" (magpie-drain ev))
           (cons "value" (or (magpie-eval-value ev) ""))
           (cons "error" (and (magpie-eval-error-p ev) t)))))

  (defun magpie-running (ev)
    (magpie-json
     (list (cons "status" "running")
           (cons "eval_id" (magpie-eval-id ev))
           (cons "output" (magpie-drain ev)))))

  (defun magpie-find (id)
    (gethash (if (integerp id) id (ignore-errors (parse-integer (princ-to-string id))))
             *magpie-evals*))

  (defun magpie-eval-status (id)
    "One non-blocking look at a background eval started by this session.
Returns readable text, the same lane as every other eval answer."
    (let ((ev (magpie-find id)))
      (if (null ev)
          (format nil "eval ~a: unknown" id)
          (let ((output (magpie-drain ev))
                (done (magpie-eval-done-p ev)))
            (when done (magpie-log-eval ev))
            (with-output-to-string (out)
              (format out "eval ~a: ~a" (magpie-eval-id ev)
                      (if done "exited" "running"))
              (unless (string= output "")
                (format out "~%output:~%~a" output))
              (when (and done (magpie-eval-value ev))
                (format out "~%value: ~a" (magpie-eval-value ev))))))))

  (defun magpie-eval-await (id &key (yield-ms 10000) until-exit)
    "Park until EVAL ID finishes (or prints), at most YIELD-MS."
    (let ((ev (magpie-find id)))
      (when ev
        (if until-exit
            (ignore-errors (sb-thread:join-thread (magpie-eval-thread ev)))
            (magpie-park ev yield-ms)))
      (magpie-eval-status id)))

  (defun magpie-eval-interrupt (id &key force)
    "Abort EVAL ID."
    (let ((ev (magpie-find id)))
      (when ev
        (let ((thread (magpie-eval-thread ev)))
          (when (and thread (sb-thread:thread-alive-p thread))
            (if force
                (sb-thread:terminate-thread thread)
                (ignore-errors
                  (sb-thread:interrupt-thread
                   thread (lambda () (error "eval interrupted by the client"))))))))
      :ok))

  (defun magpie-eval-list ()
    "Every eval this session started, newest first."
    (let ((rows '()))
      (maphash (lambda (id ev)
                 (declare (ignore id))
                 (push (list (magpie-eval-id ev)
                             (if (magpie-eval-done-p ev) "exited" "running"))
                       rows))
               *magpie-evals*)
      (setf rows (sort rows #'< :key #'first))
      (with-output-to-string (out)
        (if (null rows)
            (write-string "no evals in this session" out)
            (dolist (row rows)
              (format out "~a  ~a~%" (first row) (second row))))
        (let ((historical
                (and (stringp *magpie-eval-log-path*)
                     (probe-file *magpie-eval-log-path*)
                     (ignore-errors
                      (length (magpie-log-records
                               (uiop:read-file-string *magpie-eval-log-path*)))))))
          (when (and historical (plusp historical))
            (format out "~a background exit~:p in (magpie-eval-log)~%" historical))))))

  ;; eval-string reads bare symbols in NODECODE.EVOLVED.  `nodecode trial`
  ;; installs the engine's own LOOK after this file is read, so swap it on every
  ;; eval (cheap, idempotent) right before eval-string sees the form.
  (defun magpie-install-look ()
    (let ((look-symbol (find-symbol "LOOK" :nodecode.evolved)))
      (when look-symbol
        (setf (symbol-function look-symbol) (symbol-function 'magpie-look)))))

  (defun magpie-watch-background (ev ms)
    "Mark EV as a background eval once MS passes with it still running."
    (when (and (numberp ms) (plusp ms))
      (sb-thread:make-thread
       (lambda ()
         (sleep (/ ms 1000.0))
         (unless (magpie-eval-done-p ev)
           (setf (magpie-eval-background-p ev) t))
         (magpie-log-eval ev))
       :name (format nil "magpie-watch-~d" (magpie-eval-id ev)))))

  (defun magpie-op-eval (request)
    (magpie-install-look)
    (let* ((form (gethash "form" request))
           (yield-ms (or (gethash "yield_time_ms" request) 10000))
           (after-ms (gethash "background_after_ms" request))
           (ev (magpie-start form (gethash "strings" request))))
      (magpie-watch-background ev after-ms)
      (if (magpie-park ev yield-ms)
          (magpie-exited ev)
          (magpie-running ev))))

  (defun magpie-op-status (request)
    (let ((ev (magpie-find (gethash "id" request))))
      (cond ((null ev)
             (magpie-json (list (cons "status" "unknown")
                                (cons "eval_id" (gethash "id" request)))))
            ((magpie-eval-done-p ev) (magpie-exited ev))
            (t (magpie-running ev)))))

  (defun magpie-op-interrupt (request)
    (let ((ev (magpie-find (gethash "id" request))))
      (when ev
        (let ((thread (magpie-eval-thread ev)))
          (when (and thread (sb-thread:thread-alive-p thread))
            (if (gethash "force" request)
                (sb-thread:terminate-thread thread)
                (ignore-errors
                  (sb-thread:interrupt-thread
                   thread
                   (lambda ()
                     (error "eval interrupted by the client"))))))))
      (magpie-json (list (cons "status" "ok")))))

  (defun magpie-op-list (request)
    (declare (ignore request))
    (let ((rows '()))
      (maphash (lambda (id ev)
                 (declare (ignore id))
                 (push (magpie-json
                        (list (cons "eval_id" (magpie-eval-id ev))
                              (cons "status" (if (magpie-eval-done-p ev) "exited" "running"))
                              (cons "value" (or (magpie-eval-value ev) ""))))
                       rows))
               *magpie-evals*)
      (magpie-json (list (cons "status" "ok") (cons "evals" (coerce rows 'vector))))))

  (defun magpie-dispatch (request)
    (let ((op (gethash "op" request)))
      (cond ((equal op "eval") (magpie-op-eval request))
            ((equal op "status") (magpie-op-status request))
            ((equal op "interrupt") (magpie-op-interrupt request))
            ((equal op "list") (magpie-op-list request))
            ((equal op "ping") (magpie-json (list (cons "status" "ok"))))
            (t (magpie-json (list (cons "status" "error")
                                  (cons "message" (format nil "unknown op: ~a" op))))))))

  (defun magpie-serve-line (stream line)
    (let* ((request (handler-case (nlk:decode-json line :whole t)
                      (error () (make-hash-table :test 'equal))))
           (req-id (gethash "req_id" request))
           (response
             (handler-case
                 (magpie-dispatch request)
               (error (e)
                 (magpie-json (list (cons "status" "error")
                                    (cons "message" (format nil "~a" e))))))))
      (when req-id (setf (gethash "req_id" response) req-id))
      (format stream "~a~%" (nlk:encode-json-object response))
      (finish-output stream)))

  (let* ((path __MAGPIE_SOCKET__)
         (sock (make-instance 'sb-bsd-sockets:local-socket :type :stream :protocol 0)))
    (when (probe-file path) (delete-file path))
    (sb-bsd-sockets:socket-bind sock path)
    (sb-bsd-sockets:socket-listen sock 16)
    (loop
      (let ((conn (sb-bsd-sockets:socket-accept sock)))
        (unwind-protect
             (with-open-stream
                 (stream (sb-bsd-sockets:socket-make-stream conn :input t :output t
                                                           :element-type 'character
                                                           :buffering :full))
               (loop
                 (let ((line (read-line stream nil :eof)))
                   (when (eq line :eof) (return))
                   (unless (zerop (length (string-trim '(#\Space #\Tab #\Return) line)))
                     (magpie-serve-line stream line)))))
          (sb-bsd-sockets:socket-close conn))))))
