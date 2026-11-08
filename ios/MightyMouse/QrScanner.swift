import AVFoundation
import SwiftUI
import UIKit
import Vision

/// Camera QR scanning via Vision. Native because the web `BarcodeDetector` API
/// does not exist in any iOS browser engine.
final class QrScannerController: UIViewController {
    /// Called with the decoded string, or nil when the user backs out.
    private let onResult: (String?) -> Void
    private let session = AVCaptureSession()
    private let output = AVCaptureVideoDataOutput()
    /// Vision runs off the main thread; the sample-buffer queue is its own.
    private let queue = DispatchQueue(label: "com.mightymouse.qrscan")
    private var preview: AVCaptureVideoPreviewLayer?
    /// Guards against a second detection landing while the dismiss animates.
    private var finished = false

    /// Side of the clear reticle, as a fraction of the narrower screen edge.
    private static let reticleScale: CGFloat = 0.68
    private let scrim = CAShapeLayer()
    private let corners = CAShapeLayer()
    private let sweep = CAGradientLayer()
    private var reticle: CGRect = .zero
    private let titleLabel = UILabel()
    private let hintLabel = UILabel()
    private let settingsButton = UIButton(type: .system)

    init(onResult: @escaping (String?) -> Void) {
        self.onResult = onResult
        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not from a nib") }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        configureSession()
        addChrome()
        showCameraOffIfDenied()
    }

    private func showCameraOffIfDenied() {
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .denied, .restricted:
            showCameraOff()
        case .notDetermined:
            // Fires alongside the system prompt the capture session raises, and answers with the same tap.
            AVCaptureDevice.requestAccess(for: .video) { [weak self] granted in
                guard !granted else { return }
                DispatchQueue.main.async { self?.showCameraOff() }
            }
        default:
            break
        }
    }

    private func showCameraOff() {
        titleLabel.text = "Camera is off"
        hintLabel.text = "Turn on Camera for MightyMouse in Settings, then scan your Mac's code."
        settingsButton.isHidden = false
        corners.isHidden = true
        sweep.isHidden = true
    }

    @objc private func openSettingsTapped() {
        guard let url = URL(string: UIApplication.openSettingsURLString) else { return }
        UIApplication.shared.open(url)
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        // startRunning blocks; keeping it off main avoids a hitch on present.
        queue.async { [weak self] in
            guard let self, !self.session.isRunning else { return }
            self.session.startRunning()
        }
    }

    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        queue.async { [weak self] in self?.session.stopRunning() }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        preview?.frame = view.bounds
        layoutReticle()
    }

    /// Centres the cutout on the frame and redraws everything keyed to it.
    /// Sits slightly above centre so the copy below has room without crowding.
    private func layoutReticle() {
        let side = min(view.bounds.width, view.bounds.height) * Self.reticleScale
        let origin = CGPoint(x: (view.bounds.width - side) / 2,
                             y: (view.bounds.height - side) / 2 - side * 0.08)
        let next = CGRect(origin: origin, size: CGSize(width: side, height: side))
        guard next != reticle else { return }
        reticle = next

        let radius = side * 0.09
        let mask = UIBezierPath(rect: view.bounds)
        mask.append(UIBezierPath(roundedRect: reticle, cornerRadius: radius).reversing())
        scrim.frame = view.bounds
        scrim.path = mask.cgPath

        // Anchored on the reticle so the lock-on pop scales toward the code, not
        // the screen's top-left.
        corners.bounds = view.bounds
        corners.anchorPoint = CGPoint(x: reticle.midX / view.bounds.width,
                                      y: reticle.midY / view.bounds.height)
        corners.position = CGPoint(x: reticle.midX, y: reticle.midY)
        corners.path = cornerBracketPath(in: reticle, radius: radius).cgPath

        sweep.frame = CGRect(x: reticle.minX, y: reticle.minY, width: side, height: side * 0.34)
        sweep.mask = {
            let fade = CAGradientLayer()
            fade.frame = sweep.bounds
            fade.colors = [UIColor.clear.cgColor, UIColor.white.cgColor]
            fade.locations = [0, 1]
            return fade
        }()
        restartSweep()
    }

    /// Four L-shaped brackets that trace the cutout's rounded corners, so the
    /// eye reads a frame without a full box closing in on the code.
    private func cornerBracketPath(in rect: CGRect, radius: CGFloat) -> UIBezierPath {
        let arm = rect.width * 0.16
        let path = UIBezierPath()
        // Each corner: straight arm in, quarter-arc round, straight arm out.
        for (corner, sweepStart) in [(CGPoint(x: rect.minX, y: rect.minY), CGFloat.pi),
                                     (CGPoint(x: rect.maxX, y: rect.minY), -CGFloat.pi / 2),
                                     (CGPoint(x: rect.maxX, y: rect.maxY), 0),
                                     (CGPoint(x: rect.minX, y: rect.maxY), CGFloat.pi / 2)] {
            let signX: CGFloat = corner.x == rect.minX ? 1 : -1
            let signY: CGFloat = corner.y == rect.minY ? 1 : -1
            let centre = CGPoint(x: corner.x + signX * radius, y: corner.y + signY * radius)
            path.move(to: CGPoint(x: corner.x + signX * radius, y: corner.y + signY * (radius + arm)))
            path.addLine(to: CGPoint(x: corner.x + signX * radius, y: centre.y))
            path.addArc(withCenter: centre, radius: radius,
                        startAngle: sweepStart + (signX * signY > 0 ? .pi / 2 : 0),
                        endAngle: sweepStart + (signX * signY > 0 ? 0 : .pi / 2),
                        clockwise: signX * signY < 0)
            path.addLine(to: CGPoint(x: corner.x + signX * (radius + arm), y: corner.y + signY * radius))
        }
        return path
    }

    private func restartSweep() {
        sweep.removeAnimation(forKey: "scan")
        let travel = CABasicAnimation(keyPath: "position.y")
        travel.fromValue = reticle.minY - sweep.bounds.height / 2
        travel.toValue = reticle.maxY + sweep.bounds.height / 2
        travel.duration = 2.4
        travel.repeatCount = .infinity
        travel.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
        travel.autoreverses = true
        sweep.add(travel, forKey: "scan")
    }

    private func configureSession() {
        session.beginConfiguration()
        defer { session.commitConfiguration() }
        guard let device = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back),
              let input = try? AVCaptureDeviceInput(device: device),
              session.canAddInput(input), session.canAddOutput(output) else {
            // Denied camera lands here too, as a nil device -- worth naming,
            // since both failures otherwise present as the same black screen.
            MMLog.pairing.error(
                "qr scan — no usable back camera (auth=\(AVCaptureDevice.authorizationStatus(for: .video).rawValue, privacy: .public))")
            return
        }
        session.addInput(input)
        // Dropping late frames keeps detection on what the lens sees NOW; a
        // backed-up queue would decode a code the user already moved past.
        output.alwaysDiscardsLateVideoFrames = true
        output.setSampleBufferDelegate(self, queue: queue)
        session.addOutput(output)

        let layer = AVCaptureVideoPreviewLayer(session: session)
        layer.videoGravity = .resizeAspectFill
        view.layer.insertSublayer(layer, at: 0)
        preview = layer
    }

    private static let accentUI = UIColor(MMColor.accentBrand)

    private func addChrome() {
        scrim.fillColor = UIColor.black.withAlphaComponent(0.62).cgColor
        scrim.fillRule = .evenOdd
        view.layer.addSublayer(scrim)

        corners.strokeColor = Self.accentUI.cgColor
        corners.fillColor = UIColor.clear.cgColor
        corners.lineWidth = 4
        corners.lineCap = .round
        view.layer.addSublayer(corners)

        sweep.colors = [Self.accentUI.withAlphaComponent(0).cgColor,
                        Self.accentUI.withAlphaComponent(0.55).cgColor]
        view.layer.addSublayer(sweep)

        // A heading, because this is now the FIRST screen of the connect flow
        // rather than a step reached from one that already said what to do.
        let title = titleLabel
        title.text = "Scan your Mac's code"
        title.textColor = .white
        title.textAlignment = .center
        title.numberOfLines = 0
        title.font = .systemFont(ofSize: 26, weight: .bold)
        title.shadowColor = UIColor.black.withAlphaComponent(0.6)
        title.shadowOffset = CGSize(width: 0, height: 1)
        title.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(title)
        NSLayoutConstraint.activate([
            title.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 24),
            title.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -24),
            title.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 28)
        ])

        let label = hintLabel
        label.text = "Open MightyMouse Settings on your Mac and point this at the QR code."
        label.textColor = .white
        label.textAlignment = .center
        label.numberOfLines = 0
        label.font = .preferredFont(forTextStyle: .body)
        label.shadowColor = UIColor.black.withAlphaComponent(0.6)
        label.shadowOffset = CGSize(width: 0, height: 1)

        // Says what it does: closes the camera. It promised a code screen, but
        // it only ever dismissed back to the sheet -- which since §11f shows no
        // code field without a host, so the promised screen never existed.
        let cancel = UIButton(type: .system)
        cancel.setTitle("Cancel", for: .normal)
        cancel.setTitleColor(.white, for: .normal)
        cancel.addTarget(self, action: #selector(cancelTapped), for: .touchUpInside)

        settingsButton.setTitle("Open Settings", for: .normal)
        settingsButton.setTitleColor(.black, for: .normal)
        settingsButton.titleLabel?.font = .systemFont(ofSize: 17, weight: .semibold)
        settingsButton.backgroundColor = Self.accentUI
        settingsButton.layer.cornerRadius = 12
        settingsButton.heightAnchor.constraint(equalToConstant: 50).isActive = true
        settingsButton.isHidden = true
        settingsButton.addTarget(self, action: #selector(openSettingsTapped), for: .touchUpInside)

        let stack = UIStackView(arrangedSubviews: [label, settingsButton, cancel])
        stack.axis = .vertical
        stack.spacing = 16
        stack.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 24),
            stack.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -24),
            stack.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor, constant: -32)
        ])
    }

    /// The brackets snap white and pulse in as the code resolves, so the dismiss
    /// reads as a lock-on rather than the screen just vanishing.
    private func flashLockOn() {
        sweep.removeAnimation(forKey: "scan")
        sweep.isHidden = true
        Haptics.play("rigid")

        let tint = CABasicAnimation(keyPath: "strokeColor")
        tint.toValue = UIColor.white.cgColor
        let pop = CABasicAnimation(keyPath: "transform.scale")
        pop.toValue = 0.94
        let group = CAAnimationGroup()
        group.animations = [tint, pop]
        group.duration = 0.18
        group.fillMode = .forwards
        group.isRemovedOnCompletion = false
        corners.add(group, forKey: "lock")
    }

    @objc private func cancelTapped() {
        finish(with: nil)
    }

    private func finish(with value: String?) {
        guard !finished else { return }
        finished = true
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            guard value != nil else {
                self.dismiss(animated: true) { self.onResult(nil) }
                return
            }
            self.flashLockOn()
            // Long enough to read the lock-on, short of feeling like a stall.
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.22) {
                self.dismiss(animated: true) { self.onResult(value) }
            }
        }
    }
}

/// Presents `QrScannerController` from SwiftUI. Hosts an empty controller and
/// presents on top of it rather than using `.fullScreenCover`, which would
/// fight a controller that dismisses itself the moment it decodes.
struct QrScanSheet: UIViewControllerRepresentable {
    @Binding var presented: Bool
    /// Nil when the user backed out.
    let onResult: (String?) -> Void

    func makeUIViewController(context: Context) -> UIViewController { UIViewController() }

    func updateUIViewController(_ host: UIViewController, context: Context) {
        guard presented, host.presentedViewController == nil, !context.coordinator.presenting else { return }
        context.coordinator.presenting = true
        let scanner = QrScannerController { value in
            context.coordinator.presenting = false
            presented = false
            onResult(value)
        }
        scanner.modalPresentationStyle = .fullScreen
        host.present(scanner, animated: true)
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    /// `updateUIViewController` fires again while the present animates, when
    /// `presentedViewController` is still nil -- without this the scanner is
    /// presented twice and the second one throws.
    final class Coordinator {
        var presenting = false
    }
}

extension QrScannerController: AVCaptureVideoDataOutputSampleBufferDelegate {
    func captureOutput(_ output: AVCaptureOutput,
                       didOutput sampleBuffer: CMSampleBuffer,
                       from connection: AVCaptureConnection) {
        guard !finished, let buffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        let request = VNDetectBarcodesRequest { [weak self] request, _ in
            guard let self, !self.finished else { return }
            let codes = request.results as? [VNBarcodeObservation] ?? []
            // Only QR: the Mac shows nothing else, and accepting other symbologies
            // would let a stray barcode in the frame resolve as a pairing target.
            guard let payload = codes.first(where: { $0.symbology == .qr })?.payloadStringValue else { return }
            MMLog.pairing.log("qr decoded (\(payload.count, privacy: .public) chars)")
            self.finish(with: payload)
        }
        request.symbologies = [.qr]
        try? VNImageRequestHandler(cvPixelBuffer: buffer, orientation: .right).perform([request])
    }
}
